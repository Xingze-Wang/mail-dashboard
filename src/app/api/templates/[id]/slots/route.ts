import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

/**
 * GET /api/templates/[id]/slots
 *
 * Returns the 6 paragraph slots of one email_templates row, plus
 * minimal metadata. Used by the Fork modal on /templates/bench so
 * admin can pre-fill the editor with the parent's content before
 * varying one paragraph; AND by /templates/[id]/edit which is the
 * shared edit/review surface (both admin and sales reps).
 *
 * Distinct from GET /api/templates which lists rows from the OLD
 * `templates` (singular) table — different table, different shape.
 *
 * Auth: any logged-in rep (sales reps need to read slots in order to
 * propose edits). Mutations stay admin-only via PATCH; queue
 * submissions go through POST.
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

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // GET is open to any logged-in rep so sales can see slots in order
  // to propose edits via POST. PATCH stays admin-only below.
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Login required" }, { status: 401 });

  const { id } = await params;
  const { data, error } = await supabase
    .from("email_templates")
    .select(
      "id, name, status, segment_default, subject_format, intro_prompt, greeting_format, rep_intro_format, school_pitch_format, cta_signoff_format",
    )
    .eq("id", id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });

  return NextResponse.json(data);
}

const EDITABLE_SLOTS = [
  "subject_format",
  "intro_prompt",
  "greeting_format",
  "rep_intro_format",
  "school_pitch_format",
  "cta_signoff_format",
] as const;
type Slot = typeof EDITABLE_SLOTS[number];

/**
 * PATCH /api/templates/[id]/slots
 *
 * Body: {
 *   subject_format?: string,
 *   intro_prompt?: string,
 *   greeting_format?: string,
 *   rep_intro_format?: string,
 *   school_pitch_format?: string,
 *   cta_signoff_format?: string,
 *   segment_default?: string | null,
 *   notes?: string,
 * }
 *
 * Edits a template's slot content + selection logic. Two safety
 * rules:
 *
 *   1. Active templates CANNOT be edited in place. Forces a fork-
 *     edit-promote flow. Returns 409 with a hint to use POST
 *     /api/templates/fork instead.
 *
 *   2. Slot edits run through editor gate (template-prose-pipeline
 *     editParagraph) for each slot that's actually changed. Editor
 *     scores get saved to template_ratings (rater_kind='ai'). Reject
 *     verdicts surface in the response but DON'T block the save —
 *     admin has agency to override the gate. The next render still
 *     uses the new content.
 *
 * Auth: admin only.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  // Load current state for diff + edit guard.
  const { data: current } = await supabase
    .from("email_templates")
    .select(
      "id, name, status, segment_default, subject_format, intro_prompt, greeting_format, rep_intro_format, school_pitch_format, cta_signoff_format, notes",
    )
    .eq("id", id)
    .maybeSingle();
  if (!current) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (current.status === "active") {
    return NextResponse.json(
      {
        error:
          "Cannot edit an active template in place. Fork it first (POST /api/templates/fork) " +
          "to create a proposal copy, edit that, then activate when ready. This guard prevents " +
          "accidental drift in production prose.",
      },
      { status: 409 },
    );
  }

  // Build update + figure out which slots actually changed.
  const updates: Record<string, unknown> = {};
  const changedSlots: Slot[] = [];
  for (const slot of EDITABLE_SLOTS) {
    const incoming = body[slot];
    if (typeof incoming !== "string") continue;
    if (incoming === (current as Record<string, string>)[slot]) continue;
    updates[slot] = incoming;
    changedSlots.push(slot);
  }
  if (typeof body.segment_default === "string" || body.segment_default === null) {
    updates.segment_default = body.segment_default;
  }
  if (typeof body.notes === "string") {
    updates.notes = body.notes.slice(0, 1000);
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ ok: true, changed: 0, note: "no changes" });
  }
  updates.updated_at = new Date().toISOString();

  // Run editor gate on each changed slot, in parallel. We don't block
  // on a reject — admin sees the verdict and decides. But we DO save
  // the editor's scores so the insights page reflects them.
  const gateResults: Array<{ slot: Slot; verdict: string; issues: number; tone: string }> = [];
  if (changedSlots.length > 0) {
    const { editParagraph } = await import("@/lib/template-prose-pipeline");
    await Promise.all(
      changedSlots.map(async (slot) => {
        try {
          const review = await editParagraph({
            paragraph: updates[slot] as string,
            slot,
          });
          gateResults.push({
            slot,
            verdict: review.verdict,
            issues: review.issues.length,
            tone: review.tone_assessment,
          });
          // Save scores to template_ratings (one row per template,
          // upserted). Note: this OVERWRITES any prior AI rating —
          // since the template content changed, the prior rating is
          // stale anyway.
          if (review.scores) {
            await supabase.from("template_ratings").upsert(
              {
                template_id: id,
                rater_kind: "ai",
                model_id: "gemini-3-flash",
                politeness: review.scores.politeness,
                clarity: review.scores.clarity,
                peer_register: review.scores.peer_register,
                brand_fit: review.scores.brand_fit,
                factual_accuracy: review.scores.factual_accuracy,
                naturalness: review.scores.naturalness,
                reasoning: review.tone_assessment,
                updated_at: new Date().toISOString(),
              },
              { onConflict: "template_id,rater_kind,rater_id" },
            );
          }
        } catch (e) {
          gateResults.push({ slot, verdict: "error", issues: 0, tone: (e as Error).message.slice(0, 100) });
        }
      }),
    );
  }

  // Now save the actual updates.
  const { error: upErr } = await supabase
    .from("email_templates")
    .update(updates)
    .eq("id", id);
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  return NextResponse.json({
    ok: true,
    changed: Object.keys(updates).length - 1, // minus updated_at
    changed_slots: changedSlots,
    gate_results: gateResults,
  });
}

/**
 * POST /api/templates/[id]/slots — DIFF QUEUE submission path
 *
 * Same body shape as PATCH, but doesn't mutate email_templates.
 * Instead each changed slot becomes a row in template_edits with
 * status='pending', awaiting admin review.
 *
 * Why two endpoints with the same body:
 *   - PATCH = admin direct edit (admin's edit IS the approval)
 *   - POST  = anyone, queued for review
 *
 * The gate runs at submit time and stores its annotations in the
 * template_edits row, so the admin reviewer sees "the gate flagged
 * this as 销售腔" alongside the diff. The gate doesn't block — it
 * annotates. Admin has final say.
 *
 * If a pending edit already exists on the same (template, slot), it
 * gets marked 'superseded' and the new one becomes the live pending
 * row. This avoids a queue full of stale duplicates.
 *
 * Auth: any logged-in rep.
 */
const QUEUEABLE_SLOTS = [...EDITABLE_SLOTS, "segment_default", "notes"] as const;
type QueueableSlot = typeof QUEUEABLE_SLOTS[number];

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Login required" }, { status: 401 });

  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown> & {
    rep_rationale?: unknown;
  };

  const { data: current } = await supabase
    .from("email_templates")
    .select(
      "id, name, status, segment_default, subject_format, intro_prompt, greeting_format, rep_intro_format, school_pitch_format, cta_signoff_format, notes",
    )
    .eq("id", id)
    .maybeSingle();
  if (!current) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Determine changed slots vs current.
  const proposedDiffs: Array<{ slot: QueueableSlot; old_value: string | null; new_value: string | null }> = [];
  for (const slot of QUEUEABLE_SLOTS) {
    if (!(slot in body)) continue;
    const incoming = body[slot];
    // segment_default + notes accept null. Others must be string.
    if (slot === "segment_default") {
      if (incoming !== null && typeof incoming !== "string") continue;
    } else if (typeof incoming !== "string") {
      continue;
    }
    const oldVal = (current as Record<string, string | null>)[slot] ?? null;
    const newVal = (incoming as string | null) ?? null;
    if (oldVal === newVal) continue;
    proposedDiffs.push({ slot, old_value: oldVal, new_value: newVal });
  }

  if (proposedDiffs.length === 0) {
    return NextResponse.json({ ok: true, submitted: 0, note: "no changes" });
  }

  const repRationale = typeof body.rep_rationale === "string" ? body.rep_rationale.slice(0, 500) : null;

  // Run gate on each diff in parallel. Only the prose slots get the
  // editor gate — segment_default + notes are mechanical and don't
  // need prose review.
  const { editParagraph } = await import("@/lib/template-prose-pipeline");
  const gateOutcomes = await Promise.all(
    proposedDiffs.map(async (d) => {
      if (d.slot === "segment_default" || d.slot === "notes") {
        return { gate_verdict: null, gate_annotations: null };
      }
      try {
        const review = await editParagraph({
          paragraph: (d.new_value ?? "") as string,
          slot: d.slot,
        });
        return {
          gate_verdict: review.verdict,
          gate_annotations: {
            issues: review.issues,
            tone_assessment: review.tone_assessment,
            scores: review.scores ?? null,
          },
        };
      } catch (e) {
        return {
          gate_verdict: "error" as const,
          gate_annotations: { error: (e as Error).message.slice(0, 200) },
        };
      }
    }),
  );

  // Mark prior pending edits on the same (template, slot) as superseded.
  // This is a small N — at most one pending row per slot in practice.
  for (const d of proposedDiffs) {
    await supabase
      .from("template_edits")
      .update({ status: "superseded" })
      .eq("template_id", id)
      .eq("slot_key", d.slot)
      .eq("status", "pending");
  }

  // Insert new pending rows.
  const rows = proposedDiffs.map((d, i) => ({
    template_id: id,
    slot_key: d.slot,
    old_value: d.old_value,
    new_value: d.new_value,
    gate_verdict: gateOutcomes[i].gate_verdict,
    gate_annotations: gateOutcomes[i].gate_annotations,
    status: "pending",
    submitted_by_rep_id: session.repId,
    rep_rationale: repRationale,
  }));
  const { data: inserted, error: insErr } = await supabase
    .from("template_edits")
    .insert(rows)
    .select("id, slot_key, gate_verdict, gate_annotations");
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });

  return NextResponse.json({
    ok: true,
    submitted: inserted?.length ?? 0,
    edits: inserted ?? [],
    note: "Submitted for admin review. Changes are NOT live yet.",
  });
}
