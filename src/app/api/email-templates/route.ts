import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * GET  /api/email-templates          — list all (admin)
 * PATCH /api/email-templates         — { id, active }  flip active flag
 * DELETE /api/email-templates?id=... — remove a row (only per-rep ones;
 *                                      refuses to delete "global")
 *
 * This endpoint is the admin review surface for voice-capture output.
 * `build_rep_template` inserts INACTIVE rows; admin reads them here
 * and flips active=true when satisfied. Draft assembly prefers the
 * active per-rep template over global once flipped.
 */

export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const { data, error } = await supabase
    .from("email_templates")
    .select("*")
    .order("name", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ templates: data ?? [] });
}

export async function PATCH(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const body = await req.json().catch(() => ({}));
  const id = typeof body.id === "string" ? body.id : null;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body.active === "boolean") updates.active = body.active;
  if (typeof body.subject_format === "string") updates.subject_format = body.subject_format;
  if (typeof body.greeting_format === "string") updates.greeting_format = body.greeting_format;
  if (typeof body.rep_intro_format === "string") updates.rep_intro_format = body.rep_intro_format;
  if (typeof body.school_pitch_format === "string") updates.school_pitch_format = body.school_pitch_format;
  if (typeof body.cta_signoff_format === "string") updates.cta_signoff_format = body.cta_signoff_format;
  if (typeof body.notes === "string") updates.notes = body.notes;

  const { data, error } = await supabase
    .from("email_templates")
    .update(updates)
    .eq("id", id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ template: data });
}

export async function DELETE(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  // Guard: deleting "global" breaks draft assembly for everyone. Only
  // per-rep rows are safe to remove. Admin can always edit global
  // via PATCH.
  const { data: existing } = await supabase
    .from("email_templates")
    .select("name")
    .eq("id", id)
    .maybeSingle();
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (existing.name === "global") {
    return NextResponse.json({ error: "Cannot delete the global template" }, { status: 400 });
  }

  const { error } = await supabase.from("email_templates").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ deleted: true });
}
