import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

const ALLOWED_SLOTS = new Set([
  "subject_format",
  "intro_prompt",
  "greeting_format",
  "rep_intro_format",
  "school_pitch_format",
  "cta_signoff_format",
]);

const ALLOWED_GEO = new Set(["cn", "edu", "other"]);

/**
 * GET /api/email-templates/overrides?templateId=
 * POST same with { templateId, slotName, when, value, notes? }
 * DELETE same with { id }
 *
 * Segment-conditional overrides for any email_templates slot. The
 * template-assembler reads them at render time; first match wins.
 */
export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;
  const url = new URL(req.url);
  const templateId = url.searchParams.get("templateId");
  if (!templateId) return NextResponse.json({ error: "templateId required" }, { status: 400 });
  const { data, error } = await supabase
    .from("email_template_overrides")
    .select("*")
    .eq("template_id", templateId)
    .order("created_at", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ overrides: data ?? [] });
}

export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;
  const body = await req.json().catch(() => ({}));
  const templateId = String(body.templateId ?? "");
  const slotName = String(body.slotName ?? "");
  const when = (body.when ?? {}) as Record<string, unknown>;
  const value = String(body.value ?? "");
  const notes = body.notes ? String(body.notes) : null;

  if (!templateId) return NextResponse.json({ error: "templateId required" }, { status: 400 });
  if (!ALLOWED_SLOTS.has(slotName)) {
    return NextResponse.json({ error: `slotName must be one of ${[...ALLOWED_SLOTS].join("|")}` }, { status: 400 });
  }
  if (value.length === 0 || value.length > 4000) {
    return NextResponse.json({ error: "value must be 1-4000 chars" }, { status: 400 });
  }
  // Validate `when` keys/types narrowly so the assembler's matchesContext
  // never has to deal with garbage shapes.
  if (when.geo !== undefined && !ALLOWED_GEO.has(String(when.geo))) {
    return NextResponse.json({ error: "when.geo must be cn|edu|other" }, { status: 400 });
  }
  if (when.school_tier !== undefined && !Number.isFinite(Number(when.school_tier))) {
    return NextResponse.json({ error: "when.school_tier must be a number" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("email_template_overrides")
    .insert({ template_id: templateId, slot_name: slotName, when, value, notes })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ override: data });
}

export async function DELETE(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const { error } = await supabase.from("email_template_overrides").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
