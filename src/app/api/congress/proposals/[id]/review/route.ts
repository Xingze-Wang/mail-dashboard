import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/congress/proposals/[id]/review
 *
 * Bundle everything an admin needs to evaluate a single template
 * proposal that congress generated:
 *
 *   - The proposal row itself (proposed_reason, proposed_evidence,
 *     all slot contents).
 *   - The hypothesis it came from (text, reasoning, segment, status)
 *     — looked up via proposed_evidence.hypothesis_id against
 *     congress_hypotheses.
 *   - The baseline template it's diffing against (so admin can see
 *     before vs after on the swapped slot).
 *   - Any admin feedback already left on this proposal (replies
 *     stored in helper_chime_in_log + a new proposal_feedback table).
 *
 * Replaces the old /congress/discuss sandbox runs — admins want to
 * see what the council debated about a REAL proposal, not run a
 * fresh synthetic deliberation.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  const { data: proposal, error } = await supabase
    .from("email_templates")
    .select("id, name, status, segment_default, proposed_by, proposed_reason, proposed_evidence, subject_format, intro_prompt, greeting_format, rep_intro_format, school_pitch_format, cta_signoff_format, created_at, updated_at")
    .eq("id", id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!proposal) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });

  // Hypothesis lookup — soft join (proposal might not have one).
  let hypothesis = null;
  const ev = proposal.proposed_evidence as { hypothesis_id?: string; baseline_template_id?: string; slot_swapped?: string; what_changed?: string; expected_pitfall?: string; editor_tone_assessment?: string } | null;
  if (ev?.hypothesis_id) {
    const { data: h } = await supabase
      .from("congress_hypotheses")
      .select("id, hypothesis, reasoning, segment, status, generated_at, outcome_evidence")
      .eq("id", ev.hypothesis_id)
      .maybeSingle();
    hypothesis = h;
  }

  // Baseline template for diff.
  let baseline = null;
  if (ev?.baseline_template_id) {
    const { data: b } = await supabase
      .from("email_templates")
      .select("id, name, status, segment_default, subject_format, intro_prompt, greeting_format, rep_intro_format, school_pitch_format, cta_signoff_format")
      .eq("id", ev.baseline_template_id)
      .maybeSingle();
    baseline = b;
  }

  // Existing feedback — pull from proposal_feedback (created in mig 080)
  // if the table exists. Best-effort because at first deploy the table
  // is empty; surfacing nothing is fine.
  let feedback: Array<{ id: string; body: string; author_name: string; created_at: string; revision_run_id: string | null }> = [];
  try {
    const { data } = await supabase
      .from("proposal_feedback")
      .select("id, body, author_rep_id, created_at, revision_run_id")
      .eq("template_proposal_id", id)
      .order("created_at", { ascending: true });
    if (data && data.length > 0) {
      const repIds = [...new Set(data.map((d) => d.author_rep_id as number).filter(Boolean))];
      const { data: reps } = await supabase.from("sales_reps").select("id, sender_name, name").in("id", repIds);
      const nameMap = new Map((reps ?? []).map((r) => [r.id as number, (r.sender_name ?? r.name) as string]));
      feedback = data.map((d) => ({
        id: d.id as string,
        body: d.body as string,
        author_name: nameMap.get(d.author_rep_id as number) ?? `rep#${d.author_rep_id}`,
        created_at: d.created_at as string,
        revision_run_id: (d.revision_run_id as string | null) ?? null,
      }));
    }
  } catch {/* table may not exist yet */}

  return NextResponse.json({
    proposal,
    hypothesis,
    baseline,
    feedback,
    swapped_slot: ev?.slot_swapped ?? null,
  });
}
