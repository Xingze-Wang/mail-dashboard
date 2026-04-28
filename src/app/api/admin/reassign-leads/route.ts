import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/admin/reassign-leads
 *
 * Admin-only bulk re-assign of pipeline_leads.assigned_rep_id with a
 * cascade onto emails.rep_id (the OWNER mirror, not actor — see
 * CLAUDE.md memory: actor_rep_id stays untouched because it records
 * who literally pressed send).
 *
 * Three modes via the `mode` field:
 *   - "ids": payload includes lead_ids[]; reassigns those.
 *   - "filter": payload includes a filter (currentRepId? leadTier?
 *     status?); reassigns the matching set. Useful for "move every
 *     ready strong lead from Leo to Mei."
 *   - "preview": same as "filter" but doesn't write — returns the
 *     count that WOULD be reassigned and a 5-row sample. Lets the
 *     admin sanity-check before applying.
 *
 * Body:
 *   {
 *     mode: "ids" | "filter" | "preview",
 *     toRepId: number,
 *     lead_ids?: string[],
 *     filter?: {
 *       currentRepId?: number | null,  // null = unassigned
 *       leadTier?: "strong" | "normal",
 *       status?: string,
 *     }
 *   }
 *
 * Response:
 *   {
 *     reassigned: number,   // number of pipeline_leads rows updated
 *     emailsCascaded: number, // number of emails.rep_id rows updated
 *     sample?: Lead[],      // only on preview mode
 *   }
 */

interface Filter {
  currentRepId?: number | null;
  leadTier?: "strong" | "normal";
  status?: string;
}

/* applyFilter inlined at call site; supabase chained-builder typing
 * doesn't survive being passed through a helper */

export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const body = await req.json().catch(() => ({}));
  const mode = String(body.mode ?? "");
  const toRepId = Number(body.toRepId);
  if (!Number.isFinite(toRepId)) {
    return NextResponse.json({ error: "toRepId must be a number" }, { status: 400 });
  }

  // Resolve the target rep up front so we fail fast on bad input.
  const { data: targetRep, error: repErr } = await supabase
    .from("sales_reps")
    .select("id, name, active")
    .eq("id", toRepId)
    .maybeSingle();
  if (repErr || !targetRep) {
    return NextResponse.json({ error: "target rep not found" }, { status: 404 });
  }
  if (targetRep.active === false) {
    return NextResponse.json({ error: `rep ${targetRep.name} is inactive` }, { status: 400 });
  }

  // ── Resolve target lead IDs ──────────────────────────────────────
  let leadIds: string[] = [];
  if (mode === "ids") {
    if (!Array.isArray(body.lead_ids)) {
      return NextResponse.json({ error: "lead_ids[] required for mode=ids" }, { status: 400 });
    }
    leadIds = body.lead_ids.filter((id: unknown): id is string => typeof id === "string");
    if (leadIds.length === 0) return NextResponse.json({ error: "lead_ids[] empty" }, { status: 400 });
    if (leadIds.length > 500) return NextResponse.json({ error: "lead_ids[] capped at 500 per call" }, { status: 400 });
  } else if (mode === "filter" || mode === "preview") {
    const filter = (body.filter ?? {}) as Filter;
    let q = supabase
      .from("pipeline_leads")
      .select("id, title, author_name, assigned_rep_id, lead_tier, status, thread_id");
    if (filter.currentRepId === null) q = q.is("assigned_rep_id", null);
    else if (typeof filter.currentRepId === "number") q = q.eq("assigned_rep_id", filter.currentRepId);
    if (filter.leadTier) q = q.eq("lead_tier", filter.leadTier);
    if (filter.status) q = q.eq("status", filter.status);
    const { data, error } = await q.limit(2000);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const matching = (data ?? []).filter((l) => l.assigned_rep_id !== toRepId); // skip no-ops
    if (mode === "preview") {
      return NextResponse.json({
        reassigned: 0,
        emailsCascaded: 0,
        wouldReassign: matching.length,
        sample: matching.slice(0, 5).map((l) => ({
          id: l.id,
          title: l.title,
          author_name: l.author_name,
          fromRepId: l.assigned_rep_id,
          leadTier: l.lead_tier,
          status: l.status,
        })),
        targetRep: { id: targetRep.id, name: targetRep.name },
      });
    }
    leadIds = matching.map((l) => l.id as string);
  } else {
    return NextResponse.json({ error: "mode must be ids | filter | preview" }, { status: 400 });
  }

  if (leadIds.length === 0) {
    return NextResponse.json({ reassigned: 0, emailsCascaded: 0 });
  }

  // ── Pull the rows so we have thread_ids for the cascade ─────────
  const { data: leadsToUpdate, error: pullErr } = await supabase
    .from("pipeline_leads")
    .select("id, thread_id")
    .in("id", leadIds);
  if (pullErr) return NextResponse.json({ error: pullErr.message }, { status: 500 });

  const threadIds = (leadsToUpdate ?? []).map((l) => l.thread_id).filter((t): t is string => !!t);

  // ── Update pipeline_leads ────────────────────────────────────────
  const { error: leadErr, count } = await supabase
    .from("pipeline_leads")
    .update({ assigned_rep_id: toRepId }, { count: "exact" })
    .in("id", leadIds);
  if (leadErr) return NextResponse.json({ error: leadErr.message }, { status: 500 });

  // ── Cascade emails.rep_id (owner mirror only — actor_rep_id stays) ──
  let cascaded = 0;
  if (threadIds.length > 0) {
    // Chunk to stay under postgrest's URL limit. Same chunk size that
    // worked for the templates/performance fix yesterday.
    const CHUNK = 150;
    for (let i = 0; i < threadIds.length; i += CHUNK) {
      const chunk = threadIds.slice(i, i + CHUNK);
      const { error: emailErr, count: c } = await supabase
        .from("emails")
        .update({ rep_id: toRepId }, { count: "exact" })
        .in("thread_id", chunk);
      if (emailErr) {
        console.warn("emails cascade chunk failed", { i, err: emailErr.message });
        continue;
      }
      cascaded += c ?? 0;
    }
  }

  return NextResponse.json({
    reassigned: count ?? 0,
    emailsCascaded: cascaded,
    targetRep: { id: targetRep.id, name: targetRep.name },
  });
}
