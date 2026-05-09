import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

export const maxDuration = 30;

/**
 * POST /api/templates/[id]/activate
 * Body: { segment_default?: string | null, archive_template_id?: string }
 *
 * Second half of the two-stage approval (migration 066). Flips a
 * status='approved_draft' row to 'active' — meaning admin ALSO
 * approved the routing rule (segment assignment) for this template.
 * After this call, loadEffectiveTemplate matches the template and
 * production traffic flows through it.
 *
 * Body fields:
 *   - segment_default: pin this template to a specific segment
 *     ('cn' | 'overseas' | 'edu' | null). Optional — admin may
 *     activate without a segment if the template is meant as the
 *     org-wide global. Stored on email_templates.segment_default.
 *   - archive_template_id: simultaneously archive the prior template
 *     for this segment so we don't have two actives competing.
 *
 * Pre-condition: source row must be status='approved_draft' OR
 * already 'active' (idempotent re-activate).
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
  const body = (await req.json().catch(() => ({}))) as {
    segment_default?: string | null;
    archive_template_id?: string;
  };

  const { data: target } = await supabase
    .from("email_templates")
    .select("id, name, status, segment_default")
    .eq("id", id)
    .maybeSingle();
  if (!target) return NextResponse.json({ error: "template not found" }, { status: 404 });
  if (target.status !== "approved_draft" && target.status !== "active") {
    return NextResponse.json(
      {
        error:
          `Can't activate from status=${target.status}. ` +
          `Run /approve-draft first to confirm the prose.`,
      },
      { status: 409 },
    );
  }

  // Update status + (optionally) segment_default.
  const update: Record<string, unknown> = {
    status: "active",
    updated_at: new Date().toISOString(),
  };
  if (body.segment_default !== undefined) {
    update.segment_default = body.segment_default;
  }
  const { error } = await supabase
    .from("email_templates")
    .update(update)
    .eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Atomically (well, transactionally close enough) archive the
  // prior template for the same segment so there's only one active
  // per segment. If admin didn't pass archive_template_id, find it.
  let archived: { id: string; name: string } | null = null;
  let archiveTarget = body.archive_template_id ?? null;
  if (!archiveTarget && update.segment_default) {
    const { data: prior } = await supabase
      .from("email_templates")
      .select("id, name")
      .eq("status", "active")
      .eq("segment_default", update.segment_default)
      .neq("id", id)
      .limit(1)
      .maybeSingle();
    archiveTarget = (prior?.id as string | null) ?? null;
  }
  if (archiveTarget && archiveTarget !== id) {
    const { data: arch } = await supabase
      .from("email_templates")
      .select("id, name")
      .eq("id", archiveTarget)
      .maybeSingle();
    if (arch) {
      const { error: arErr } = await supabase
        .from("email_templates")
        .update({ status: "archived", active: false, updated_at: new Date().toISOString() })
        .eq("id", archiveTarget);
      if (arErr) {
        return NextResponse.json(
          { ok: true, activated: { id, name: target.name }, archive_failed: arErr.message },
          { status: 207 },
        );
      }
      archived = { id: arch.id, name: arch.name };
    }
  }

  return NextResponse.json({
    ok: true,
    activated: { id, name: target.name },
    segment_default: update.segment_default ?? target.segment_default,
    archived,
  });
}
