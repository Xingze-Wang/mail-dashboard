import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

export const maxDuration = 30;

/**
 * POST /api/templates/[id]/approve-draft
 *
 * First half of the two-stage approval (migration 066). Flips a
 * status='proposal' row to 'approved_draft' — meaning admin has
 * reviewed the prose and signed off on the TEXT of the draft.
 *
 * Production traffic does NOT flow through approved_draft templates.
 * That requires a separate POST /api/templates/[id]/activate which
 * also approves the segment routing rule.
 *
 * Idempotent: re-approving an already-approved_draft is a no-op.
 *
 * Auth: admin only.
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
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const { id } = await params;
  const { data: target } = await supabase
    .from("email_templates")
    .select("id, name, status")
    .eq("id", id)
    .maybeSingle();
  if (!target) return NextResponse.json({ error: "template not found" }, { status: 404 });

  // Allowed transitions: proposal → approved_draft, approved_draft →
  // approved_draft (idempotent). Block from active or archived.
  if (target.status !== "proposal" && target.status !== "approved_draft") {
    return NextResponse.json(
      {
        error: `Can't approve_draft from status=${target.status}. Use the proposal flow first.`,
      },
      { status: 409 },
    );
  }

  const { error } = await supabase
    .from("email_templates")
    .update({ status: "approved_draft", updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, name: target.name, status: "approved_draft" });
}
