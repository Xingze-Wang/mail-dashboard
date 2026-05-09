import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

/**
 * POST /api/admin/template-edits/[edit_id]/reject
 *
 * Sets a pending template_edit to 'rejected' with an optional
 * review_note. Doesn't touch the live email_templates row.
 *
 * Auth: admin only.
 *
 * Body: { review_note?: string }   // recommended — explains to the
 *                                     submitter why
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

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ edit_id: string }> },
) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const { edit_id } = await params;
  const body = (await req.json().catch(() => ({}))) as { review_note?: unknown };
  const reviewNote = typeof body.review_note === "string" ? body.review_note.slice(0, 500) : null;

  const { data: edit } = await supabase
    .from("template_edits")
    .select("id, status")
    .eq("id", edit_id)
    .maybeSingle();
  if (!edit) return NextResponse.json({ error: "Edit not found" }, { status: 404 });
  if (edit.status !== "pending") {
    return NextResponse.json(
      { error: `Edit already ${edit.status} — cannot reject` },
      { status: 409 },
    );
  }

  const { error } = await supabase
    .from("template_edits")
    .update({
      status: "rejected",
      reviewed_by_rep_id: admin.repId,
      reviewed_at: new Date().toISOString(),
      review_note: reviewNote,
    })
    .eq("id", edit_id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
