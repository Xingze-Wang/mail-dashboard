import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * GET  /api/admin/model-prompts — list all prompts (active + archived)
 * POST /api/admin/model-prompts — add a new prompt to the leaderboard
 *   { kind, name, persona_archetype?, system_prompt, llm_model?, notes? }
 *
 * Admin only. The bench page lets admins compare prompts side by side
 * and ship a winner — this endpoint is the create-side.
 */
export async function GET(req: NextRequest) {
  const r = await requireAdmin(req);
  if ("response" in r) return r.response;

  const { data, error } = await supabase
    .from("model_prompts")
    .select("id, kind, name, persona_archetype, llm_model, active, created_at, notes, archived_at, archived_reason")
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ prompts: data ?? [] });
}

export async function POST(req: NextRequest) {
  const r = await requireAdmin(req);
  if ("response" in r) return r.response;

  const body = (await req.json().catch(() => ({}))) as {
    kind?: string;
    name?: string;
    persona_archetype?: string;
    system_prompt?: string;
    llm_model?: string;
    notes?: string;
  };

  const VALID_KINDS = new Set(["persona_recipient", "email_quality_judge", "ctr_regressor"]);
  if (!body.kind || !VALID_KINDS.has(body.kind)) {
    return NextResponse.json({ error: "kind must be persona_recipient | email_quality_judge | ctr_regressor" }, { status: 400 });
  }
  if (!body.name || body.name.length < 3 || body.name.length > 80) {
    return NextResponse.json({ error: "name required (3-80 chars)" }, { status: 400 });
  }
  if (!body.system_prompt || body.system_prompt.length < 30) {
    return NextResponse.json({ error: "system_prompt required (≥30 chars)" }, { status: 400 });
  }
  if (body.kind === "persona_recipient" && !body.persona_archetype) {
    return NextResponse.json({ error: "persona_archetype required for kind=persona_recipient" }, { status: 400 });
  }

  const { data, error } = await supabase.from("model_prompts").insert({
    kind: body.kind,
    name: body.name,
    persona_archetype: body.persona_archetype ?? null,
    system_prompt: body.system_prompt,
    llm_model: body.llm_model ?? "gemini-2.5-flash",
    notes: body.notes ?? null,
    created_by_rep_id: r.session.repId,
  }).select().single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, prompt: data });
}
