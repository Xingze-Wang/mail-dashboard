import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

export const maxDuration = 30;

/**
 * POST /api/templates/[id]/promote — DEPRECATED single-click flip.
 *
 * Migration 066 split approval into two stages:
 *   /approve-draft → status: proposal | approved_draft → approved_draft
 *   /activate      → status: approved_draft | active → active
 *
 * This endpoint is preserved for back-compat: it does BOTH steps in
 * one call. New UI should call the two endpoints separately so admin
 * has explicit consent for each stage. The promote endpoint stays
 * available for one-off scripts and the bench-page Activate button
 * that hasn't been split yet.
 *
 * Body: { archive_template_id?: string } — same as before.
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
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const body = (await req.json().catch(() => ({}))) as { archive_template_id?: string };

  // Verify the target exists and isn't already active.
  const { data: target } = await supabase
    .from("email_templates")
    .select("id, name, status")
    .eq("id", id)
    .maybeSingle();
  if (!target) return NextResponse.json({ error: "template not found" }, { status: 404 });

  // Promote: status → 'active'. Idempotent — promoting an already-active
  // template no-ops the status write and just refreshes updated_at.
  const { error: upErr } = await supabase
    .from("email_templates")
    .update({ status: "active", updated_at: new Date().toISOString() })
    .eq("id", id);
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  let archived: { id: string; name: string } | null = null;
  if (body.archive_template_id && body.archive_template_id !== id) {
    const { data: arch } = await supabase
      .from("email_templates")
      .select("id, name")
      .eq("id", body.archive_template_id)
      .maybeSingle();
    if (arch) {
      const { error: arErr } = await supabase
        .from("email_templates")
        .update({ status: "archived", active: false, updated_at: new Date().toISOString() })
        .eq("id", body.archive_template_id);
      if (arErr) {
        // Promote already happened — that's fine, but tell caller the
        // archive step failed so they can retry it manually.
        return NextResponse.json(
          {
            ok: true,
            promoted: { id, name: target.name },
            archive_failed: arErr.message,
          },
          { status: 207 }, // Multi-Status — promote OK, archive partial
        );
      }
      archived = { id: arch.id, name: arch.name };
    }
  }

  return NextResponse.json({
    ok: true,
    promoted: { id, name: target.name },
    archived,
  });
}
