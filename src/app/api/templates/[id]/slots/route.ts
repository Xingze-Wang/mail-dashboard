import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

/**
 * GET /api/templates/[id]/slots
 *
 * Returns the 6 paragraph slots of one email_templates row, plus
 * minimal metadata. Used by the Fork modal on /templates/bench so
 * admin can pre-fill the editor with the parent's content before
 * varying one paragraph.
 *
 * Distinct from GET /api/templates which lists rows from the OLD
 * `templates` (singular) table — different table, different shape.
 *
 * Auth: admin only. Slots aren't secret per se, but they're internal
 * configuration; sales-side surfaces shouldn't poke at them.
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

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const { id } = await params;
  const { data, error } = await supabase
    .from("email_templates")
    .select(
      "id, name, status, segment_default, subject_format, intro_prompt, greeting_format, rep_intro_format, school_pitch_format, cta_signoff_format",
    )
    .eq("id", id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });

  return NextResponse.json(data);
}
