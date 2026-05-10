import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

export const maxDuration = 30;

/**
 * POST /api/templates/[id]/reject
 * Body: { reason: string }
 *
 * Admin rejects a proposal with an explanation. Stamps three
 * columns added in migration 076:
 *   - rejection_reason: the why (required, ≥10 chars)
 *   - rejected_at: timestamp
 *   - rejected_by_rep_id: audit
 *
 * Status flips to 'archived' (existing status from mig 066). The
 * reason is the meaningful artifact — it goes into the next
 * weekly congress's evidence pack so the synthesizer learns
 * "this was tried and rejected because Y" and stops re-proposing
 * the same kind of change.
 *
 * Idempotent on already-rejected: returns 409 to avoid silently
 * overwriting a prior reason.
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
  const body = (await req.json().catch(() => ({}))) as { reason?: string };
  const reason = (body.reason ?? "").trim();
  if (reason.length < 10) {
    return NextResponse.json(
      { error: "Reason required (≥10 chars). The reason becomes congress evidence — be specific." },
      { status: 400 },
    );
  }
  if (reason.length > 1500) {
    return NextResponse.json({ error: "Reason too long (max 1500 chars)" }, { status: 400 });
  }

  const { data: target } = await supabase
    .from("email_templates")
    .select("id, name, status, rejection_reason")
    .eq("id", id)
    .maybeSingle();
  if (!target) return NextResponse.json({ error: "template not found" }, { status: 404 });

  // Block re-rejecting an already-rejected proposal — the second
  // reason would silently overwrite the first, losing audit info.
  if (target.status === "archived" && target.rejection_reason) {
    return NextResponse.json(
      { error: "Already rejected. To change the reason, contact a higher-privilege admin." },
      { status: 409 },
    );
  }
  // Block rejecting active templates — admin should explicitly
  // archive a different way to avoid confusing the routing layer.
  if (target.status === "active") {
    return NextResponse.json(
      { error: "Can't reject an active template. Activate a replacement first, then this row will be auto-archived." },
      { status: 409 },
    );
  }

  const { error } = await supabase
    .from("email_templates")
    .update({
      status: "archived",
      active: false,
      rejection_reason: reason,
      rejected_at: new Date().toISOString(),
      rejected_by_rep_id: admin.repId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    ok: true,
    name: target.name,
    status: "archived",
    rejection_reason: reason,
  });
}
