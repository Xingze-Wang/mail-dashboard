import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

/**
 * POST /api/admin/template-edits/[edit_id]/approve
 *
 * Atomic-ish merge: applies the diff stored in the template_edits row
 * to the live email_templates row, then marks the edit row 'approved'.
 *
 * "Atomic-ish" = two writes (UPDATE template, UPDATE edit row). If the
 * second fails after the first succeeds, we have a merged-but-not-
 * recorded state — the live template has the new prose but the queue
 * row still says 'pending'. Manual reconciliation: an admin can re-
 * approve, which will be a no-op merge + a successful status flip.
 * Acceptable risk; the alternative is a 2-table transaction we don't
 * have a clean wrapper for.
 *
 * Active templates: an approved edit on an 'active' row IS allowed
 * here — the diff queue is the sanctioned path for editing actives.
 * The 409 in PATCH only blocks the direct mutation path.
 *
 * Auth: admin only.
 *
 * Body (optional): { review_note?: string }
 */

async function requireAdmin(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return null;
  const { data: rep } = await supabase
    .from("sales_reps")
    .select("role")
    .eq("id", session.repId)
    .maybeSingle();
  if (!rep || rep.role !== "admin") return null;
  return session;
}

const APPLYABLE_SLOTS = [
  "subject_format",
  "intro_prompt",
  "greeting_format",
  "rep_intro_format",
  "school_pitch_format",
  "cta_signoff_format",
  "segment_default",
  "notes",
] as const;
type ApplySlot = typeof APPLYABLE_SLOTS[number];

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ edit_id: string }> },
) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const { edit_id } = await params;
  const body = (await req.json().catch(() => ({}))) as { review_note?: unknown };

  const { data: edit } = await supabase
    .from("template_edits")
    .select("id, template_id, slot_key, new_value, status")
    .eq("id", edit_id)
    .maybeSingle();
  if (!edit) return NextResponse.json({ error: "Edit not found" }, { status: 404 });
  if (edit.status !== "pending") {
    return NextResponse.json(
      { error: `Edit already ${edit.status} — cannot re-approve` },
      { status: 409 },
    );
  }
  if (!APPLYABLE_SLOTS.includes(edit.slot_key as ApplySlot)) {
    return NextResponse.json({ error: `Unknown slot: ${edit.slot_key}` }, { status: 400 });
  }

  // Step 1: apply to live template
  const { error: upErr } = await supabase
    .from("email_templates")
    .update({
      [edit.slot_key as string]: edit.new_value,
      updated_at: new Date().toISOString(),
    })
    .eq("id", edit.template_id);
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  // Step 2: mark edit row approved
  const reviewNote = typeof body.review_note === "string" ? body.review_note.slice(0, 500) : null;
  const { error: stampErr } = await supabase
    .from("template_edits")
    .update({
      status: "approved",
      reviewed_by_rep_id: admin.repId,
      reviewed_at: new Date().toISOString(),
      review_note: reviewNote,
    })
    .eq("id", edit_id);
  if (stampErr) {
    // Live template was already mutated. Surface the inconsistency
    // explicitly rather than silently swallowing.
    return NextResponse.json(
      {
        ok: false,
        applied: true,
        error: `Template merged but edit row not stamped: ${stampErr.message}`,
      },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, applied: true });
}
