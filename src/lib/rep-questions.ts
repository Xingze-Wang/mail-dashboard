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

/**
 * Look back at this rep's recent questions to see if the current one
 * is a near-duplicate of something they've asked before.
 *
 * Returns count + sample previous raw_text. Used by lark-agent to
 * decide whether to NUDGE Leon to propose_tool ("you've answered this
 * 3 times in 2 weeks — make it a tool").
 *
 * Uses trigram similarity via the rep_questions_similar RPC if
 * available, else falls back to substring matching on normalized text.
 */
export async function recentRepetitionsForQuestion(args: {
  repId: number | null;
  question: string;
  lookbackDays?: number;
  similarityThreshold?: number;
}): Promise<{ count: number; samples: string[]; first_asked_at: string | null }> {
  const repId = args.repId;
  if (!repId) return { count: 0, samples: [], first_asked_at: null };
  const lookback = args.lookbackDays ?? 14;
  const threshold = args.similarityThreshold ?? 0.25;
  const since = new Date(Date.now() - lookback * 86_400_000).toISOString();
  const normalized = normalizeQuestion(args.question);
  if (normalized.length < 5) return { count: 0, samples: [], first_asked_at: null };

  try {
    // Trigram similarity via existing RPC (created by migration 087)
    const { data } = await supabase.rpc("rep_questions_similar", {
      target_text: normalized,
      threshold,
      since_iso: since,
    });
    if (data && Array.isArray(data)) {
      const filtered = data.filter((r: { rep_id?: number | null }) => r.rep_id === repId);
      const samples = filtered
        .slice(0, 3)
        .map((r: { raw_text?: string }) => (r.raw_text ?? "").slice(0, 160));
      // Earliest first_asked_at for context ("you first asked this on 5/8")
      let earliest: string | null = null;
      for (const r of filtered as Array<{ asked_at?: string }>) {
        const t = r.asked_at;
        if (t && (!earliest || t < earliest)) earliest = t;
      }
      return { count: filtered.length, samples, first_asked_at: earliest };
    }
  } catch (err) {
    console.warn("[rep-questions] similarity RPC failed, falling back:", err);
  }

  // Fallback: prefix match on normalized text (cheap, less accurate)
  const { data: fallback } = await supabase
    .from("rep_questions")
    .select("raw_text, normalized, asked_at")
    .eq("rep_id", repId)
    .gte("asked_at", since)
    .order("asked_at", { ascending: true })
    .limit(50);
  const matches = (fallback ?? []).filter((r) => {
    if (!r.normalized) return false;
    const n = String(r.normalized).slice(0, 80);
    return normalized.includes(n.slice(0, 30)) || n.includes(normalized.slice(0, 30));
  });
  return {
    count: matches.length,
    samples: matches.slice(0, 3).map((r) => (r.raw_text ?? "").slice(0, 160)),
    first_asked_at: matches[0]?.asked_at ?? null,
  };
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
