import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

/**
 * GET /api/templates/library
 *
 * Returns all email_templates rows (the new system — distinct from the
 * legacy `templates` singular table that GET /api/templates serves).
 * Used by /templates → Library tab to surface proposals (especially
 * congress-generated ones), approved drafts, active templates, and
 * archived. Single response shape so the UI can filter client-side.
 *
 * Auth: any logged-in user. Sales reps see all templates (they're
 * shared infrastructure); only admin can mutate via the activate /
 * approve-draft / promote endpoints.
 */
async function requireAuth(req: NextRequest) {
  const session = await requireSession(req);
  return session;
}

export async function GET(req: NextRequest) {
  const session = await requireAuth(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("email_templates")
    .select(
      // Pull slot contents too so the Library card can show a preview
      // sample of WHAT changed (especially valuable for proposals where
      // the swapped paragraph IS the whole point of looking at it).
      "id, name, status, segment_default, rep_id, proposed_by, proposed_reason, proposed_evidence, notes, created_at, updated_at, subject_format, intro_prompt, greeting_format, rep_intro_format, school_pitch_format, cta_signoff_format",
    )
    .order("status", { ascending: true })
    .order("updated_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = data ?? [];

  // Join pending template_edits per row so each card can show
  // "Suggested by Yujie — review →". Only count status='pending'
  // (superseded/approved/rejected don't need a banner). Cheap because
  // partial index template_edits_pending_idx covers the WHERE.
  const pendingByTpl = new Map<string, { count: number; latest_submitter: string | null; latest_slot: string | null; latest_verdict: string | null }>();
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id as string);
    const { data: pending } = await supabase
      .from("template_edits")
      .select("template_id, slot_key, gate_verdict, submitted_by_rep_id, submitted_at")
      .eq("status", "pending")
      .in("template_id", ids)
      .order("submitted_at", { ascending: false });
    const repIds = new Set<number>();
    for (const e of pending ?? []) repIds.add(e.submitted_by_rep_id as number);
    const repName = new Map<number, string>();
    if (repIds.size > 0) {
      const { data: reps } = await supabase
        .from("sales_reps")
        .select("id, sender_name, name")
        .in("id", [...repIds]);
      for (const r of reps ?? []) {
        repName.set(r.id as number, ((r.sender_name as string | null) ?? (r.name as string | null) ?? `rep#${r.id}`));
      }
    }
    for (const e of pending ?? []) {
      const tplId = e.template_id as string;
      const cur = pendingByTpl.get(tplId);
      if (cur) {
        cur.count++;
      } else {
        pendingByTpl.set(tplId, {
          count: 1,
          // First entry (newest, since we ordered desc) becomes the
          // "latest" attribution shown on the banner.
          latest_submitter: repName.get(e.submitted_by_rep_id as number) ?? null,
          latest_slot: (e.slot_key as string) ?? null,
          latest_verdict: (e.gate_verdict as string | null) ?? null,
        });
      }
    }
  }

  const enriched = rows.map((r) => ({
    ...r,
    pending_edits: pendingByTpl.get(r.id as string) ?? null,
  }));

  return NextResponse.json({ rows: enriched });
}
