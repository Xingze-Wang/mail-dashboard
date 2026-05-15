// model-router.ts — centralized "which model for which task" decision.
//
// The Claude pattern: Opus thinks (judgment, debate, planning), Sonnet
// executes (formatting, summarizing, classification, repetition). For
// us:
//   - Opus 4.7: interactive lark-agent main loop, intent planner,
//     congress debate personas, drift mining, demand-signal scoring
//   - Sonnet 4.6: nightly briefs, congress topic proposer, daily
//     digests, structured classifications where format > nuance
//   - Haiku 4.5: cheapest classification — admin-inbox source
//     inference, single-shot yes/no decisions
//
// Why not just hardcode per-callsite: as we add LLM calls, we forget
// to think about tier. One central function means new callsites have
// to pick a TASK label, which forces the right question.

export type LLMTask =
  | "agent_interactive"      // Lark/web help-bot main loop (Opus)
  | "agent_planner"          // intent → guided_task plan (Opus)
  | "agent_debate"           // congress persona, multi-step argument (Opus)
  | "drift_mining"           // analyzing sales edits for patterns (Opus — judgment-heavy)
  | "demand_scoring"         // scoring lead replies for buying signal (Opus)
  // ── Mid-tier: structured output, scored by format-correctness ──
  | "nightly_brief"          // daily-rep-brief generation (Sonnet)
  | "congress_proposer"      // mid-week debate topic suggester (Sonnet)
  | "insights_cards"         // /analysis page cards (Sonnet)
  | "self_skill_judge"       // future: grade Leon's own answers (Sonnet)
  | "summarize"              // brief summary tasks (Sonnet)
  // ── Lightweight: classification, routing ──
  | "classify_kind"          // skill vs memory vs both classification (Haiku)
  | "classify_intent"        // user intent routing (Haiku)
  | "yes_no_judge"           // single binary decision (Haiku)
  | "extract_field";         // pull one field from text (Haiku)

interface ModelChoice {
  model: string;
  temperature: number;
  max_tokens: number;
  timeout_ms: number;
}

const ROUTE_TABLE: Record<LLMTask, ModelChoice> = {
  // Heavyweight (Opus) — slow but actually thinks
  agent_interactive: { model: "claude-opus-4.7", temperature: 0.4, max_tokens: 4000, timeout_ms: 60_000 },
  agent_planner:     { model: "claude-opus-4.7", temperature: 0.3, max_tokens: 2000, timeout_ms: 60_000 },
  agent_debate:      { model: "claude-opus-4.7", temperature: 0.6, max_tokens: 3000, timeout_ms: 90_000 },
  drift_mining:      { model: "claude-opus-4.7", temperature: 0.3, max_tokens: 4000, timeout_ms: 90_000 },
  demand_scoring:    { model: "claude-opus-4.7", temperature: 0.2, max_tokens: 1000, timeout_ms: 45_000 },

  // Mid-tier (Sonnet) — fast, structured outputs
  nightly_brief:      { model: "claude-sonnet-4.6", temperature: 0.4, max_tokens: 800, timeout_ms: 45_000 },
  congress_proposer:  { model: "claude-sonnet-4.6", temperature: 0.4, max_tokens: 1500, timeout_ms: 60_000 },
  insights_cards:     { model: "claude-sonnet-4.6", temperature: 0.3, max_tokens: 1500, timeout_ms: 60_000 },
  self_skill_judge:   { model: "claude-sonnet-4.6", temperature: 0.2, max_tokens: 800, timeout_ms: 45_000 },
  summarize:          { model: "claude-sonnet-4.6", temperature: 0.3, max_tokens: 600, timeout_ms: 30_000 },

  // Lightweight (Haiku) — for high-volume / cheap calls
  classify_kind:    { model: "claude-haiku-4-5", temperature: 0.0, max_tokens: 300, timeout_ms: 20_000 },
  classify_intent:  { model: "claude-haiku-4-5", temperature: 0.0, max_tokens: 200, timeout_ms: 15_000 },
  yes_no_judge:     { model: "claude-haiku-4-5", temperature: 0.0, max_tokens: 100, timeout_ms: 10_000 },
  extract_field:    { model: "claude-haiku-4-5", temperature: 0.0, max_tokens: 200, timeout_ms: 15_000 },
};

/**
 * Pick the right model config for a task. Use this instead of hardcoding
 * model strings throughout the codebase — it makes the cost/quality
 * tradeoff visible and editable.
 */
export function modelFor(task: LLMTask): ModelChoice {
  return ROUTE_TABLE[task];
}

/**
 * Convenience: given a task + system/user prompts, returns a complete
 * llmChat args object. Caller does `llmChat(makeLLMArgs(...))`.
 */
export function makeLLMArgs(task: LLMTask, args: {
  system: string;
  user: string;
  json?: boolean;
}): {
  model: string;
  system: string;
  user: string;
  temperature: number;
  max_tokens: number;
  timeoutMs: number;
  json?: boolean;
} {
  const m = modelFor(task);
  return {
    model: m.model,
    system: args.system,
    user: args.user,
    temperature: m.temperature,
    max_tokens: m.max_tokens,
    timeoutMs: m.timeout_ms,
    ...(args.json !== undefined ? { json: args.json } : {}),
  };
}
