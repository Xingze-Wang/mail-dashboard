import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * POST /api/email-templates/[id]/versions/[versionId]/restore
 *
 * Restores a snapshot back into email_templates. The current state is
 * automatically captured to history (via the same trg_capture trigger)
 * so a restore is itself reversible.
 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string; versionId: string }> }) {
  const gate = await requireAdmin(_req);
  if ("response" in gate) return gate.response;
  const { id, versionId } = await ctx.params;

  const { data: ver, error: vErr } = await supabase
    .from("email_template_versions")
    .select("snapshot, template_id")
    .eq("id", versionId)
    .maybeSingle();
  if (vErr || !ver) return NextResponse.json({ error: "version not found" }, { status: 404 });
  if (ver.template_id !== id) return NextResponse.json({ error: "version does not belong to this template" }, { status: 400 });

  const snap = ver.snapshot as Record<string, unknown>;
  const updates = {
    subject_format: snap.subject_format,
    intro_prompt: snap.intro_prompt,
    greeting_format: snap.greeting_format,
    rep_intro_format: snap.rep_intro_format,
    school_pitch_format: snap.school_pitch_format,
    cta_signoff_format: snap.cta_signoff_format,
    notes: snap.notes,
    active: snap.active,
    updated_at: new Date().toISOString(),
  };
  const { error: uErr } = await supabase.from("email_templates").update(updates).eq("id", id);
  if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
