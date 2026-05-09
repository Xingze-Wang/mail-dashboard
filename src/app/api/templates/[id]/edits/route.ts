import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/templates/[id]/edits
 *   ?status=pending|all  (default 'pending')
 *
 * Lists template_edits rows for a single template. Used by the edit
 * page so admin sees all pending edits to approve/reject, and the
 * submitter sees their own queued edits + status.
 *
 * Returns:
 *   {
 *     edits: [{
 *       id, slot_key, old_value, new_value, gate_verdict,
 *       gate_annotations, status, submitted_by_rep_id, submitter_name,
 *       submitted_at, rep_rationale, ...
 *     }]
 *   }
 *
 * Auth: any logged-in rep. Non-admins see all edits — submitting an
 * edit is public per-template, no privacy reason to hide them.
 *
 * The actual approve/reject endpoints (under /api/admin/template-edits)
 * still gate on admin role.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? "pending";

  let q = supabase
    .from("template_edits")
    .select(
      "id, slot_key, old_value, new_value, gate_verdict, gate_annotations, status, submitted_by_rep_id, submitted_at, reviewed_by_rep_id, reviewed_at, review_note, rep_rationale",
    )
    .eq("template_id", id)
    .order("submitted_at", { ascending: false })
    .limit(50);
  if (status !== "all") q = q.eq("status", status);

  const { data: rawEdits, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const edits = rawEdits ?? [];

  // Resolve submitter names so the edit page UI can show "submitted by Yujie".
  const repIds = Array.from(new Set(edits.map((e) => e.submitted_by_rep_id as number)));
  const repName = new Map<number, string>();
  if (repIds.length > 0) {
    const { data: reps } = await supabase
      .from("sales_reps")
      .select("id, sender_name, name")
      .in("id", repIds);
    for (const r of reps ?? []) {
      repName.set(r.id as number, ((r.sender_name as string | null) ?? (r.name as string | null) ?? `rep#${r.id}`));
    }
  }

  const enriched = edits.map((e) => ({
    ...e,
    submitter_name: repName.get(e.submitted_by_rep_id as number) ?? `rep#${e.submitted_by_rep_id}`,
  }));

  return NextResponse.json({ edits: enriched });
}
