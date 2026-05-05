// Proposal lifecycle helpers — the advisory chokepoint between agents
// and the real database. Companies/agents submit; admins approve;
// executors materialize. No agent ever writes to pipeline_leads,
// emails, or email_templates directly.

import { supabase } from "@/lib/db";
import { reviewContent } from "@/lib/editor-agent";

export type ProposalKind =
  | "template_swap"
  | "subject_test"
  | "routing_rule"
  | "pacing_change"
  | "lead_skip"
  | "draft_revise"
  | "segment_target_shift";

export type ProposalState =
  | "pending"
  | "editor_review"
  | "admin_review"
  | "approved"
  | "rejected"
  | "executed"
  | "expired"
  | "withdrawn";

export interface ProposalSubmitInput {
  company_id: string;
  contract_id?: string | null;
  investor_id?: string | null;
  kind: ProposalKind;
  payload: Record<string, unknown>;
  affected_targets?: Record<string, unknown>;
  prediction?: string;
}

/**
 * Submit a proposal. Auto-runs the editor gate immediately for any
 * "content-touching" proposal; routing/pacing changes skip editor (they
 * don't affect what's said, only who-gets-what or how fast).
 */
export async function submitProposal(input: ProposalSubmitInput): Promise<{ proposal_id: string; state: ProposalState; editor_verdict?: string } | { error: string }> {
  const { data: row, error } = await supabase
    .from("company_proposals")
    .insert({
      company_id: input.company_id,
      contract_id: input.contract_id ?? null,
      investor_id: input.investor_id ?? null,
      kind: input.kind,
      payload: input.payload,
      affected_targets: input.affected_targets ?? {},
      prediction: input.prediction ?? "",
      state: "pending",
    })
    .select("id")
    .single();
  if (error || !row) return { error: error?.message ?? "insert failed" };

  // Content-touching kinds → run editor automatically.
  const contentKinds: ProposalKind[] = ["template_swap", "subject_test", "draft_revise"];
  if (contentKinds.includes(input.kind)) {
    await supabase.from("company_proposals").update({ state: "editor_review" }).eq("id", row.id);

    const verdict = await reviewContent({
      proposed_change: { kind: input.kind, ...input.payload },
      context: input.prediction,
    });

    const { data: reviewRow } = await supabase
      .from("editor_reviews")
      .insert({
        contract_id: input.contract_id ?? null,
        proposed_change: { kind: input.kind, ...input.payload },
        verdict: verdict.verdict,
        feedback: verdict.feedback,
        raw_output: verdict.raw_output,
        prompt_version: verdict.prompt_version,
      })
      .select("id")
      .single();

    // Editor pass → admin_review; revise → admin_review with hint;
    // block → stays in editor_review until appeal lands.
    const nextState: ProposalState =
      verdict.verdict === "pass"   ? "admin_review" :
      verdict.verdict === "revise" ? "admin_review" :
                                     "editor_review";

    await supabase.from("company_proposals").update({
      state: nextState,
      editor_review_id: reviewRow?.id ?? null,
    }).eq("id", row.id);

    return { proposal_id: row.id, state: nextState, editor_verdict: verdict.verdict };
  }

  // Non-content kinds skip editor and go straight to admin queue.
  await supabase.from("company_proposals").update({ state: "admin_review" }).eq("id", row.id);
  return { proposal_id: row.id, state: "admin_review" };
}

/**
 * Admin decides on a proposal sitting in admin_review.
 */
export async function decideProposal(input: {
  proposal_id: string;
  decision: "approved" | "rejected" | "deferred";
  admin_rep_id: number;
  note?: string;
}): Promise<{ ok: boolean; new_state?: ProposalState; error?: string }> {
  const { data: prop } = await supabase
    .from("company_proposals")
    .select("id, state")
    .eq("id", input.proposal_id)
    .maybeSingle();
  if (!prop) return { ok: false, error: "proposal not found" };
  if (prop.state !== "admin_review") return { ok: false, error: `proposal is in state '${prop.state}', not admin_review` };

  const newState: ProposalState = input.decision === "approved" ? "approved" : input.decision === "rejected" ? "rejected" : "admin_review";
  await supabase.from("company_proposals").update({
    state: newState,
    admin_decision: input.decision,
    admin_decided_by: input.admin_rep_id,
    admin_decided_at: new Date().toISOString(),
    admin_note: input.note ?? null,
  }).eq("id", input.proposal_id);

  return { ok: true, new_state: newState };
}

/**
 * Materialize an approved proposal. THIS is the only function in the
 * codebase that's allowed to write to real product tables on behalf of
 * an agent. Each kind has a hand-coded handler; unsupported kinds 501.
 *
 * Today: most kinds are no-op stubs (record what would have shipped).
 * That's intentional — we don't want to hot-wire companies into prod
 * before the system has been observed running for a few weeks.
 */
export async function executeProposal(proposal_id: string): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }> {
  const { data: prop } = await supabase
    .from("company_proposals")
    .select("*")
    .eq("id", proposal_id)
    .maybeSingle();
  if (!prop) return { ok: false, error: "proposal not found" };
  if (prop.state !== "approved") return { ok: false, error: `proposal must be 'approved' to execute (current: ${prop.state})` };

  let result: Record<string, unknown> = {};

  switch (prop.kind as ProposalKind) {
    case "lead_skip": {
      // The one kind we let materialize today — skipping a lead is
      // reversible and low-risk. payload: { lead_id, reason }
      const leadId = (prop.payload as { lead_id?: string }).lead_id;
      const reason = (prop.payload as { reason?: string }).reason ?? "company-proposed skip";
      if (!leadId) { result = { error: "no lead_id in payload" }; break; }
      const { error } = await supabase.from("pipeline_leads").update({ status: "skipped", skipped_at: new Date().toISOString(), skip_reason: reason }).eq("id", leadId);
      if (error) result = { error: error.message };
      else result = { skipped_lead_id: leadId, reason };
      break;
    }
    // Stub kinds — log only; do not touch real product tables until we've
    // observed company behavior across a full quarter.
    case "template_swap":
    case "subject_test":
    case "routing_rule":
    case "pacing_change":
    case "draft_revise":
    case "segment_target_shift": {
      result = {
        stub: true,
        note: `Execution stubbed — '${prop.kind}' would ship to real tables once company behavior has been observed for one full quarter. Proposal preserved for audit.`,
        payload_preview: prop.payload,
      };
      break;
    }
  }

  await supabase.from("company_proposals").update({
    state: "executed",
    executed_at: new Date().toISOString(),
    execution_result: result,
  }).eq("id", proposal_id);

  // Lifecycle event for the timeline.
  await supabase.from("company_lifecycle").insert({
    company_id: prop.company_id,
    event: "milestone",
    label: `Proposal executed: ${prop.kind}`,
    meta: { proposal_id, kind: prop.kind, result },
  });

  return { ok: true, result };
}

/**
 * Sweep proposals whose expires_at has passed. Auto-reject so the queue
 * stays meaningful.
 */
export async function expireStaleProposals(): Promise<{ expired: number }> {
  const { data: stale } = await supabase
    .from("company_proposals")
    .select("id")
    .in("state", ["pending", "editor_review", "admin_review"])
    .lt("expires_at", new Date().toISOString());
  if (!stale || stale.length === 0) return { expired: 0 };
  await supabase.from("company_proposals").update({ state: "expired" }).in("id", stale.map((s) => s.id));
  return { expired: stale.length };
}
