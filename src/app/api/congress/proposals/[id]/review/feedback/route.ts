import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * POST /api/congress/proposals/[id]/review/feedback
 *
 * Admin leaves inline feedback on a congress-generated proposal.
 * Body: { body: string, revise?: boolean }
 *
 *   - body: 10-2000 char comment ("tone is too aggressive for senior PIs")
 *   - revise: if true, also enqueues a revise run that will regenerate
 *     this slot's prose conditioned on the feedback. The new
 *     congress_runs row id is stamped on revision_run_id.
 *
 * Auth: admin (same gate as reject/approve).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Admin check via DB role re-read (per CLAUDE.md auth model).
  const { data: rep } = await supabase
    .from("sales_reps")
    .select("role")
    .eq("id", session.repId)
    .maybeSingle();
  if (!rep || rep.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const { id: templateProposalId } = await params;
  const body = (await req.json().catch(() => ({}))) as { body?: string; revise?: boolean };
  const text = (body.body ?? "").trim();
  if (text.length < 10) {
    return NextResponse.json(
      { error: "Feedback must be ≥10 chars. Be specific — this goes into the next revise round as evidence." },
      { status: 400 },
    );
  }
  if (text.length > 2000) {
    return NextResponse.json({ error: "Feedback too long (max 2000 chars)" }, { status: 400 });
  }

  // Verify the proposal exists + is in a state where feedback makes
  // sense (proposal / approved_draft — not active or archived).
  const { data: tpl } = await supabase
    .from("email_templates")
    .select("id, status")
    .eq("id", templateProposalId)
    .maybeSingle();
  if (!tpl) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
  if (tpl.status !== "proposal" && tpl.status !== "approved_draft") {
    return NextResponse.json(
      { error: `Can only leave feedback on proposal/approved_draft (this is '${tpl.status}')` },
      { status: 409 },
    );
  }

  // Insert the feedback row. revision_run_id stays NULL for now; the
  // revise-runner endpoint (Phase 2) will stamp it once the run kicks
  // off. For v1 we just persist the comment so it lives in the thread
  // and gets read by next week's buildWeeklyEvidence.
  const { data, error } = await supabase
    .from("proposal_feedback")
    .insert({
      template_proposal_id: templateProposalId,
      author_rep_id: session.repId,
      body: text,
    })
    .select("id, created_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // v1: revise=true is acknowledged but not yet wired. The feedback
  // row alone is valuable — buildWeeklyEvidence will surface it to
  // next Monday's synthesizer. Returning revise_pending so the client
  // can show "noted, will be picked up next cycle".
  return NextResponse.json({
    ok: true,
    id: data.id,
    created_at: data.created_at,
    revise_requested: !!body.revise,
    revise_pending: !!body.revise,
  });
}
