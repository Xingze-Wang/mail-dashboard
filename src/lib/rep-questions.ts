// rep_questions logging — every rep DM is recorded with how Leon
// handled it (solo / escalated / deferred). The miner (cron) clusters
// these to find topics that need canonical onboarding answers.
//
// See migrations/087-rep-questions-curriculum.sql for the schema.

import { supabase } from "@/lib/db";
import type { ToolProposal } from "@/lib/helper-tools";

export type QuestionOutcome = "solo" | "escalated" | "deferred";

// Naive normalizer: lowercase, strip rep names + numbers + lead-id-ish
// tokens. Good enough for trigram clustering. The miner can re-normalize
// with an LLM if/when we need higher-precision clusters.
export function normalizeQuestion(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\b(yujie|leo|ethan|chenyu|mira|xingze|王泽群|王心?泽?)\b/g, "[rep]")
    .replace(/\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/g, "[uuid]")
    .replace(/\d+/g, "[N]")
    .replace(/\s+/g, " ")
    .trim();
}

// Classify Leon's reply into one of three outcomes. The caller passes:
//   - the proposal (if any) from extractAnyProposal
//   - the cleaned reply text (post-tool-extraction)
//   - whether any read_tool block was emitted in any iteration
export function classifyOutcome(args: {
  proposal: ToolProposal | null;
  cleanedReply: string;
  readToolsFired: number;
}): QuestionOutcome {
  // escalate_to_admin OR record_admin_request kind=request fires →
  // escalated
  if (args.proposal?.action === "escalate_to_admin") return "escalated";
  if (
    args.proposal?.action === "record_admin_request" &&
    String(args.proposal.kind ?? "").toLowerCase() === "request"
  ) {
    return "escalated";
  }

  // Hedge-without-action patterns. These shouldn't happen (hard rules
  // forbid them) but track for prompt-tightening.
  const text = args.cleanedReply.toLowerCase();
  const hedge = /我帮你查一下|让我看看|我想一想|我再想想|让我研究|这个我得想|等等?我看看|稍等/.test(text);
  if (hedge && args.readToolsFired === 0 && !args.proposal) {
    return "deferred";
  }

  return "solo";
}

export async function logRepQuestion(args: {
  repId: number | null;
  rawText: string;
  outcome: QuestionOutcome;
  relatedInboxId?: string | null;
  relatedLearningId?: string | null;
}): Promise<void> {
  const trimmed = args.rawText.trim();
  if (!trimmed) return;
  // Cap to keep the row reasonable. Most useful clustering happens on
  // the normalized form, not the raw.
  const raw = trimmed.slice(0, 1000);
  const normalized = normalizeQuestion(raw).slice(0, 1000);
  try {
    await supabase.from("rep_questions").insert({
      rep_id: args.repId,
      raw_text: raw,
      normalized,
      outcome: args.outcome,
      related_inbox_id: args.relatedInboxId ?? null,
      related_learning_id: args.relatedLearningId ?? null,
    });
  } catch (err) {
    console.warn("[rep-questions] insert failed (non-blocking):", err);
  }
}
