import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

export const maxDuration = 30;

/**
 * POST /api/templates/fork
 * Body: {
 *   parent_id: string,
 *   name: string,                   — must be unique
 *   overrides: Partial<{
 *     subject_format: string,
 *     intro_prompt: string,
 *     greeting_format: string,
 *     rep_intro_format: string,
 *     school_pitch_format: string,
 *     cta_signoff_format: string,
 *   }>,
 *   segment_default?: string | null,
 *   proposed_reason?: string,
 * }
 *
 * Forks an email_templates row: copies all 6 slots from `parent_id`,
 * applies any provided `overrides` (typically just one paragraph),
 * inserts as a new row with status='proposal'. The user reviews on
 * /templates/bench, then clicks Activate via /api/templates/[id]/promote.
 *
 * Why fork rather than mutate: per docs/template-experiments-design.md
 * § 5a, mutating an in-flight template breaks experiment stats. Forking
 * keeps the parent's history intact and gives a clean A row for any
 * future analysis.
 *
 * Auth: admin only.
 */

const FORKABLE_SLOTS = [
  "subject_format",
  "intro_prompt",
  "greeting_format",
  "rep_intro_format",
  "school_pitch_format",
  "cta_signoff_format",
] as const;
type Slot = typeof FORKABLE_SLOTS[number];

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

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as {
    parent_id?: string;
    name?: string;
    overrides?: Partial<Record<Slot, string>>;
    segment_default?: string | null;
    proposed_reason?: string;
  };

  if (!body.parent_id || !body.name) {
    return NextResponse.json({ error: "parent_id + name required" }, { status: 400 });
  }
  if (!body.overrides || Object.keys(body.overrides).length === 0) {
    return NextResponse.json(
      { error: "overrides must include at least one slot — otherwise this is a no-op duplicate" },
      { status: 400 },
    );
  }
  // Validate every override key is a known slot. Keeps random fields
  // from sneaking into the DB row.
  for (const k of Object.keys(body.overrides)) {
    if (!FORKABLE_SLOTS.includes(k as Slot)) {
      return NextResponse.json({ error: `unknown slot: ${k}` }, { status: 400 });
    }
  }

  // Pull parent's full slot content.
  const { data: parent } = await supabase
    .from("email_templates")
    .select(
      "subject_format, intro_prompt, greeting_format, rep_intro_format, school_pitch_format, cta_signoff_format, name",
    )
    .eq("id", body.parent_id)
    .maybeSingle();
  if (!parent) return NextResponse.json({ error: "parent template not found" }, { status: 404 });

  const newRow = {
    name: body.name,
    rep_id: null,
    active: true,
    status: "proposal",
    segment_default: body.segment_default ?? null,
    proposed_by: "admin",
    proposed_reason:
      body.proposed_reason ??
      `Fork of "${parent.name}" with ${Object.keys(body.overrides).length} paragraph(s) varied: ${Object.keys(body.overrides).join(", ")}`,
    proposed_evidence: {
      parent_template_id: body.parent_id,
      parent_name: parent.name,
      varied_slots: Object.keys(body.overrides),
      forked_at: new Date().toISOString(),
    },
    notes: `Forked from "${parent.name}" — paragraphs varied: ${Object.keys(body.overrides).join(", ")}`,
    // Slots: parent's content overlaid with the supplied overrides.
    subject_format: body.overrides.subject_format ?? parent.subject_format,
    intro_prompt: body.overrides.intro_prompt ?? parent.intro_prompt,
    greeting_format: body.overrides.greeting_format ?? parent.greeting_format,
    rep_intro_format: body.overrides.rep_intro_format ?? parent.rep_intro_format,
    school_pitch_format: body.overrides.school_pitch_format ?? parent.school_pitch_format,
    cta_signoff_format: body.overrides.cta_signoff_format ?? parent.cta_signoff_format,
  };

  const { data: inserted, error } = await supabase
    .from("email_templates")
    .insert(newRow)
    .select("id, name")
    .single();
  if (error) {
    // Most likely unique-constraint failure on `name`. Surface as 409
    // so the UI can suggest a different name.
    return NextResponse.json({ error: error.message }, { status: 409 });
  }

  return NextResponse.json({ ok: true, fork: inserted });
}
