import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/drift/human-signals
 *
 * Read-only reporting: surfaces the raw human signal that drives drift
 * mining — edit_reasons checkboxes, edit_note freeform text, and
 * lead_corrections flags. The miner already consumes these indirectly;
 * this endpoint lets admin see them unaggregated, so they can judge
 * whether auto-mined patterns match what sales actually said.
 *
 * Returns counts + recent rows (not every historical row). The 100-row
 * cap is deliberate — admin reads these by hand; infinite scroll isn't
 * the bottleneck, slow pages are.
 */

interface EditedLead {
  id: string;
  title: string | null;
  edit_reasons: string[] | null;
  edit_note: string | null;
  draft_edit_distance: number | null;
  sent_at: string | null;
  assigned_rep_id: number | null;
}

interface CorrectionRow {
  id: string;
  lead_id: string;
  rep_id: number | null;
  type: string;
  reason: string | null;
  severity: string | null;
  skip: boolean | null;
  created_at: string;
}

export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  // Edited leads — we want every row with either a reason tag or a note,
  // so admin can read the qualitative signal without clicking into each
  // individual lead. Cap at 100 newest.
  const { data: editsRaw, error: editsErr } = await supabase
    .from("pipeline_leads")
    .select("id, title, edit_reasons, edit_note, draft_edit_distance, sent_at, assigned_rep_id")
    .or("edit_reasons.not.is.null,edit_note.not.is.null")
    .order("sent_at", { ascending: false })
    .limit(100);
  if (editsErr) {
    return NextResponse.json({ error: editsErr.message }, { status: 500 });
  }
  const edits = (editsRaw ?? []) as EditedLead[];

  // Lead corrections — the sales "flag" signal. Same cap logic.
  const { data: correctionsRaw, error: corrErr } = await supabase
    .from("lead_corrections")
    .select("id, lead_id, rep_id, type, reason, severity, skip, created_at")
    .order("created_at", { ascending: false })
    .limit(100);
  if (corrErr) {
    // lead_corrections might not have rows yet but the table should exist
    // — if the query itself errors (missing table), fail loud so admin
    // notices instead of showing a silently empty list.
    return NextResponse.json({ error: corrErr.message }, { status: 500 });
  }
  const corrections = (correctionsRaw ?? []) as CorrectionRow[];

  // Aggregate counts — computed here (not client-side) so the UI stays
  // thin. We tally across the returned slice; for honest totals we'd
  // need a separate COUNT query, but for now this endpoint is "newest
  // 100" and admin knows it.
  const reasonCount: Record<string, number> = {};
  let editsWithNote = 0;
  for (const e of edits) {
    for (const r of e.edit_reasons ?? []) {
      reasonCount[r] = (reasonCount[r] ?? 0) + 1;
    }
    if (e.edit_note) editsWithNote++;
  }
  const correctionTypeCount: Record<string, number> = {};
  for (const c of corrections) {
    correctionTypeCount[c.type] = (correctionTypeCount[c.type] ?? 0) + 1;
  }

  return NextResponse.json({
    edits,
    corrections,
    stats: {
      editsShown: edits.length,
      editsWithNote,
      reasonCount,
      correctionsShown: corrections.length,
      correctionTypeCount,
    },
  });
}
