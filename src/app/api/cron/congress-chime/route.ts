import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * GET /api/cron/congress-chime
 *
 * Monday 07:30 UTC, after the weekly Tactical Congress fires at
 * 01:00 UTC. Pushes a chime-in to every active rep asking them to
 * weigh in on this week's new proposals — the rep's reply becomes
 * evidence for next Monday's Congress (closes the feedback loop
 * the same way template rejection_reason did, but for live reps
 * not just admins).
 *
 * Idempotent across reruns: helper_chime_in_log records
 * (rep_id, ref_kind='tactical_proposal'|'email_template', ref_id) so
 * if Vercel cron double-fires we don't repeatedly evict the existing
 * pending_chime_in. The current week's proposals are derived from
 * email_templates.created_at since the last Monday — same window
 * the weekly congress writes into.
 *
 * Conflict policy: if a rep already has a pending_chime_in (e.g. a
 * voice_capture_offer queued earlier), we DON'T evict it. The
 * congress chime gets logged but skipped — voice capture is
 * personal/concrete, congress is system-wide; the personal one
 * earns priority. Next week's cron will re-detect.
 *
 * Auth: Bearer $CRON_SECRET.
 *
 * Schedule: `30 7 * * 1` — Monday 07:30 UTC (weekly).
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const t0 = Date.now();
  const now = new Date();

  // Window: proposals created since last Monday 00:00 UTC. Matches
  // the cron schedule 0 1 * * 1 — anything newer than that came from
  // either today's congress run or admin manual additions.
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();

  // What's new this week? Pull both the email_templates proposals
  // (the user-visible artifact) and tactical_proposals (the spec).
  // For chime-in we lead with email_templates because that's what
  // reps actually see on /templates.
  const { data: newProposals } = await supabase
    .from("email_templates")
    .select("id, name, created_at")
    .eq("status", "proposal")
    .gte("created_at", sevenDaysAgo)
    .order("created_at", { ascending: false })
    .limit(10);

  if (!newProposals || newProposals.length === 0) {
    return NextResponse.json({
      ok: true,
      ms: Date.now() - t0,
      note: "no new proposals this week — nothing to chime",
    });
  }

  // The headline proposal — first one (most recent). Strip the auto-
  // generated suffix `proposal_h<hash>_<kind>_<date>` to a readable form.
  const top = newProposals[0];
  const topTitle = (() => {
    const m = (top.name as string).match(/proposal_h[a-f0-9]+_(.+?)_\d{8}$/);
    if (m) return m[1].replace(/_/g, " ");
    return (top.name as string).slice(0, 60);
  })();

  // Reps to chime. Active sales + admin reps; everyone gets it.
  const { data: reps } = await supabase
    .from("sales_reps")
    .select("id, name")
    .eq("active", true);

  const detectedAt = now.toISOString();
  const results: Array<{ repId: number; pushed: boolean; reason?: string }> = [];

  for (const r of reps ?? []) {
    // Idempotency check: did we already chime this rep about this
    // top proposal? If so, skip.
    const { data: prior } = await supabase
      .from("helper_chime_in_log")
      .select("id")
      .eq("rep_id", r.id)
      .eq("ref_kind", "email_template")
      .eq("ref_id", top.id)
      .maybeSingle();
    if (prior) {
      results.push({ repId: r.id, pushed: false, reason: "already chimed about this proposal" });
      continue;
    }

    // Conflict check: voice capture (or any other) chime still
    // pending? Don't evict; just log that we wanted to.
    const { data: state } = await supabase
      .from("helper_rep_state")
      .select("pending_chime_in")
      .eq("rep_id", r.id)
      .maybeSingle();
    if (state?.pending_chime_in) {
      results.push({ repId: r.id, pushed: false, reason: "another chime-in already pending" });
      continue;
    }

    // Derive a proposal_kind hint from the auto-generated name pattern,
    // since email_templates doesn't have an explicit change_kind column
    // (the kind lives on the linked tactical_proposals row).
    const kindFromName = (() => {
      const m = (top.name as string).match(/_([a-z_]+?)_\d{8}$/);
      return m ? m[1] : undefined;
    })();
    const payload = {
      type: "congress_proposal_review",
      proposal_count: newProposals.length,
      top_title: topTitle,
      proposal_kind: kindFromName,
      detected_at: detectedAt,
    };

    // Two writes: helper_rep_state (the active queue the chat box
    // pulls from) and helper_chime_in_log (the audit trail).
    // Existence-check on helper_rep_state — some reps may not have a
    // row yet.
    const { data: existing } = await supabase
      .from("helper_rep_state")
      .select("rep_id")
      .eq("rep_id", r.id)
      .maybeSingle();

    if (existing) {
      await supabase
        .from("helper_rep_state")
        .update({ pending_chime_in: payload, updated_at: new Date().toISOString() })
        .eq("rep_id", r.id);
    } else {
      await supabase
        .from("helper_rep_state")
        .insert({ rep_id: r.id, pending_chime_in: payload });
    }

    await supabase.from("helper_chime_in_log").insert({
      rep_id: r.id,
      kind: "congress_proposal_review",
      payload,
      ref_kind: "email_template",
      ref_id: top.id,
    });

    results.push({ repId: r.id, pushed: true });
  }

  return NextResponse.json({
    ok: true,
    ms: Date.now() - t0,
    proposals_window_count: newProposals.length,
    headline_proposal: { id: top.id, title: topTitle },
    rep_count: reps?.length ?? 0,
    pushed: results.filter((r) => r.pushed).length,
    skipped: results.filter((r) => !r.pushed).length,
    results,
  });
}
