import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { computeInsightsPayload } from "@/app/api/insights/route";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * GET /api/cron/insights-prewarm
 *
 * Daily cron — pre-computes the LLM-curated /api/insights payload
 * for every active rep + the admin/org-wide view, so the /analysis
 * page is instant on first click.
 *
 * Runs at 06:15 UTC, after `/api/cron/insights-realign` (06:00 UTC).
 * That ordering matters: realign rewrites today's segment-cut
 * snapshots, and the LLM payload uses those same numbers in
 * its primitives. Prewarm-after-realign means the cards on the
 * landing page are coherent with the cut pages.
 *
 * Failure model: each rep is its own try/catch. One LLM timeout
 * doesn't poison the others. The interactive route is still cache-
 * miss safe — it'll fall through to live compute if a row didn't
 * land here.
 *
 * Auth: Bearer $CRON_SECRET — same as the rest of /api/cron/*.
 *
 * Schedule: `15 6 * * *` in vercel.json.
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const t0 = Date.now();

  // Gather the rep list. Active reps + one admin row (rep_id NULL).
  const { data: reps } = await supabase
    .from("sales_reps")
    .select("id, name, role, active")
    .eq("active", true);

  // Targets: every active rep gets their own row, plus one admin
  // (rep_id NULL, role_view='admin') row for the org-wide view.
  // Admins ALSO get a per-rep row in their own scope; the page
  // picks which based on session.role at read time.
  type Target = { repId: number | null; repName: string | null; role: "admin" | "senior" | "sales"; viewAs: "rep" | "admin" };
  const targets: Target[] = [];
  // Org-wide row — uses rep_id=NULL. We need *some* admin's compute
  // context to call the read tools (they're scoped to a session).
  // Pick the first admin in the list for that.
  const firstAdmin = (reps ?? []).find((r) => r.role === "admin");
  if (firstAdmin) {
    targets.push({ repId: firstAdmin.id, repName: firstAdmin.name, role: "admin", viewAs: "admin" });
  }
  // Per-rep rows.
  for (const r of reps ?? []) {
    targets.push({
      repId: r.id,
      repName: r.name,
      role: r.role as "admin" | "senior" | "sales",
      // Even admins get a per-rep view cached so they can flip if needed.
      viewAs: r.role === "admin" ? "admin" : "rep",
    });
  }

  const today = new Date().toISOString().slice(0, 10);
  const results: Array<{ repId: number | null; viewAs: string; ok: boolean; ms: number; err?: string }> = [];

  for (const t of targets) {
    const tStart = Date.now();
    try {
      const payload = await computeInsightsPayload({
        repId: t.repId!,
        repName: t.repName,
        role: t.role,
      });

      // Skip cache write if the LLM half failed — caching empty
      // cards is worse than no cache, see GET /api/insights gate.
      const llmOk = (payload as { _llm_ok?: boolean })._llm_ok !== false;
      if (!llmOk) {
        results.push({ repId: t.repId, viewAs: t.viewAs, ok: false, ms: Date.now() - tStart, err: "llm_failed_skip_cache" });
        continue;
      }

      // For the org-wide cache row we store rep_id=NULL.
      const cacheRepId = t.viewAs === "admin" ? null : t.repId;

      // Existence check + branch (mig 077 uses partial unique
      // indexes that ON CONFLICT can't target).
      let existing = supabase
        .from("insights_llm_cache")
        .select("id")
        .eq("role_view", t.viewAs)
        .eq("effective_date", today);
      existing = cacheRepId === null ? existing.is("rep_id", null) : existing.eq("rep_id", cacheRepId);
      const { data: hit } = await existing.maybeSingle();

      if (hit) {
        await supabase.from("insights_llm_cache").update({
          payload,
          computed_at: new Date().toISOString(),
          decided_by: "cron",
          decision_model: "claude-sonnet-4.6",
        }).eq("id", hit.id);
      } else {
        await supabase.from("insights_llm_cache").insert({
          rep_id: cacheRepId,
          role_view: t.viewAs,
          payload,
          decided_by: "cron",
          decision_model: "claude-sonnet-4.6",
          effective_date: today,
        });
      }

      results.push({ repId: cacheRepId, viewAs: t.viewAs, ok: true, ms: Date.now() - tStart });
    } catch (err) {
      results.push({
        repId: t.repId,
        viewAs: t.viewAs,
        ok: false,
        ms: Date.now() - tStart,
        err: String(err).slice(0, 200),
      });
    }
  }

  return NextResponse.json({
    ok: true,
    total_ms: Date.now() - t0,
    targets: results.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  });
}
