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

  return NextResponse.json({ rows: data ?? [] });
}
