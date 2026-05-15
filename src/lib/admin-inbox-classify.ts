// admin-inbox-classify.ts — when admin clicks Yes on an idea/observation
// card, Leon (not admin) decides whether the content should become a
// 'skill' (procedure activated every session) or a 'memory' (recalled
// by relevance), or 'both'. Admin shouldn't have to make that call —
// they're saying "yes this is useful," Leon figures out shape.
//
// Heuristics first, LLM fallback if heuristics are unsure:
//   - If body contains directive language ("应该", "必须", "下次", "总是",
//     "should", "must", "when X do Y") → likely skill
//   - If body describes a fact / context / observation → likely memory
//   - Both when the content has both a fact AND a directive
//
// We use heuristics first because they're free + deterministic. LLM
// fallback only fires on ambiguous cases. Saves latency on the common path.

import { supabase } from "@/lib/db";

export type LearningShape = "skill" | "memory" | "both";

// Chinese has no word boundaries (\b), so we don't anchor those patterns.
// English patterns keep \b to avoid matching inside other words.
const DIRECTIVE_PATTERNS = [
  /(应该|必须|不要|下次|总是|永远|需要|得 |立刻|马上|直接告诉|提醒|→|->)/,
  /\b(always|never|must|should|do not|don't|when [^,.]+(then|→|->)|if [^,.]+ then|do this|please)\b/i,
];
const FACTUAL_PATTERNS = [
  /(偏好|平均|今天|昨天|这周|实际上|其实|事实|确实|发现|注意到|观察到|本质)/,
  /\b(notice|noticed|observed|prefers?|actually|in fact|on average|the (way|fact) (that|is))\b/i,
];

export function classifyByHeuristic(text: string): { shape: LearningShape; confidence: number } {
  const t = text.trim();
  if (t.length < 5) return { shape: "memory", confidence: 0.3 };

  let directiveHits = 0;
  let factualHits = 0;
  for (const p of DIRECTIVE_PATTERNS) if (p.test(t)) directiveHits++;
  for (const p of FACTUAL_PATTERNS) if (p.test(t)) factualHits++;

  if (directiveHits >= 1 && factualHits >= 1) return { shape: "both", confidence: 0.7 };
  if (directiveHits >= 1) return { shape: "skill", confidence: 0.75 };
  if (factualHits >= 1) return { shape: "memory", confidence: 0.7 };
  // Ambiguous — fall back to memory with low confidence (caller can
  // invoke LLM if it wants higher precision; for now memory is the
  // safe default since it doesn't pollute every session's prompt).
  return { shape: "memory", confidence: 0.4 };
}

export async function classifyByLLM(text: string): Promise<{ shape: LearningShape; confidence: number; reasoning: string }> {
  const { llmChat } = await import("@/lib/llm-proxy");
  const r = await llmChat({
    model: "claude-sonnet-4",
    system: `你是一个分类器. 输入是 admin 觉得有用的一段 insight, 你判断它应该被存为:
- "skill": 一个**可执行的程序 / 决策规则**, 每次 session 都该被激活 (e.g. "rep 问白名单 → 直接告诉他 lookup XXX"; "当 cluster 出现就 propose tool"). 这类适合每次都加到 prompt 里.
- "memory": 一个**事实 / 上下文 / 观察**, 只在相关 query 出现时召回 (e.g. "Yujie 偏好短主题"; "上周二 click rate 异常高"). 这类不该污染每次 session 的 prompt.
- "both": **既有事实, 又有从事实里推出来的下次怎么做**. 罕见, 但存在.

只回 JSON, 不要解释:
{"shape": "skill"|"memory"|"both", "confidence": 0.0-1.0, "reasoning": "一句话为什么"}`,
    user: `分类这条:\n\n${text.slice(0, 1500)}`,
    temperature: 0.0,
    max_tokens: 200,
  });
  // Best-effort JSON parse
  try {
    const j = JSON.parse(r.text.trim().replace(/^```json\s*|\s*```$/g, ""));
    if (j.shape === "skill" || j.shape === "memory" || j.shape === "both") {
      return {
        shape: j.shape,
        confidence: typeof j.confidence === "number" ? j.confidence : 0.6,
        reasoning: String(j.reasoning ?? "").slice(0, 300),
      };
    }
  } catch {/* fall through */}
  return { shape: "memory", confidence: 0.5, reasoning: "LLM classification failed; defaulted to memory" };
}

export async function classifyAndStoreLearning(args: {
  inbox_id: string;
  headline: string;
  body: string | null;
  original_kind: string;
}): Promise<{ stored: ("skill" | "memory")[]; classification: { shape: LearningShape; confidence: number; method: string; reasoning?: string } }> {
  const text = (args.body && args.body.length >= 10 ? args.body : args.headline).slice(0, 600);

  // Heuristic first
  let classification: { shape: LearningShape; confidence: number; method: string; reasoning?: string };
  const heuristic = classifyByHeuristic(text);
  if (heuristic.confidence >= 0.7) {
    classification = { ...heuristic, method: "heuristic" };
  } else {
    // Ambiguous — call LLM
    const llm = await classifyByLLM(text);
    classification = { ...llm, method: "llm" };
  }

  const { recordLearning } = await import("@/lib/helper-learnings");
  const stored: ("skill" | "memory")[] = [];
  const learningIds: string[] = [];

  const memoryKind: "tactic" | "self_critique" =
    args.original_kind === "idea" ? "tactic" : "self_critique";

  if (classification.shape === "skill" || classification.shape === "both") {
    const r = await recordLearning({
      scope_rep_id: null,
      kind: "skill",
      body: text,
      confidence: classification.confidence,
      evidence: {
        source: "admin_inbox_card_auto_classified",
        promoted_from_inbox: args.inbox_id,
        original_kind: args.original_kind,
        classification_method: classification.method,
        classification_reasoning: classification.reasoning,
      },
    });
    if (r) {
      learningIds.push(r.id);
      stored.push("skill");
    }
  }
  if (classification.shape === "memory" || classification.shape === "both") {
    const r = await recordLearning({
      scope_rep_id: null,
      kind: memoryKind,
      body: text,
      confidence: classification.confidence,
      evidence: {
        source: "admin_inbox_card_auto_classified",
        promoted_from_inbox: args.inbox_id,
        original_kind: args.original_kind,
        classification_method: classification.method,
        classification_reasoning: classification.reasoning,
      },
    });
    if (r) {
      learningIds.push(r.id);
      stored.push("memory");
    }
  }

  // Stamp the inbox row with what Leon decided
  await supabase
    .from("admin_inbox")
    .update({
      evidence: {
        promoted_to_learning_ids: learningIds,
        auto_classification: classification,
      },
    })
    .eq("id", args.inbox_id);

  return { stored, classification };
}
