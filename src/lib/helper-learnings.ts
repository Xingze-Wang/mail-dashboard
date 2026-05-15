// Helper learnings — durable cross-session qualitative memory for the
// sales helper. Companion to `patterns` (measured) and
// `helper_conversations` (per-thread chat history).
//
// See migrations/022-helper-learnings.sql for the schema.

import { supabase } from "@/lib/db";

// 'skill' = activatable procedure, surfaced prominently every session.
// 'tactic' / 'self_critique' = memory-style, may move to relevance-loaded later.
// 'rep_pref' = per-rep preference. 'other' = catch-all.
export type LearningKind = "rep_pref" | "tactic" | "self_critique" | "skill" | "other";

export interface HelperLearning {
  id: string;
  scope_rep_id: number | null;
  kind: LearningKind;
  body: string;
  evidence: unknown | null;
  confidence: number;
  superseded_at: string | null;
  created_at: string;
  updated_at: string;
  triggers?: string[];
  rank?: number;            // populated by loadRelevantLearnings
}

/**
 * Bulk-load: always-on for skills, recency-ordered for the rest.
 * Used in admin panels / fallback paths where there's no query context.
 */
export async function loadActiveLearnings(repId: number | null, limit = 20): Promise<HelperLearning[]> {
  const orFilter = repId
    ? `scope_rep_id.eq.${repId},scope_rep_id.is.null`
    : `scope_rep_id.is.null`;
  const { data, error } = await supabase
    .from("helper_learnings")
    .select("*")
    .is("superseded_at", null)
    .or(orFilter)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return [];
  return (data ?? []) as HelperLearning[];
}

/**
 * Per-query relevance recall — the Claude-Code-style path.
 *
 * Returns:
 *   1. ALL skills the rep has access to (skills always activate; they're
 *      a small set, ~10-20, and the model needs to see them every turn
 *      to know what to do)
 *   2. The top-N memories (tactic / rep_pref / self_critique / other)
 *      ranked by ts_rank_cd against the query
 *
 * If query is empty, falls back to the bulk load. This makes the
 * helper safe in any code path — even places that don't have a current
 * user message can still get a reasonable set of learnings.
 */
export async function loadRelevantLearnings(args: {
  query: string;
  repId: number | null;
  skillBudget?: number;     // max skills to always-load (default 15)
  memoryBudget?: number;    // max memories to rank-load (default 8)
}): Promise<HelperLearning[]> {
  const skillBudget = args.skillBudget ?? 15;
  const memoryBudget = args.memoryBudget ?? 8;
  const totalCeiling = skillBudget + memoryBudget;

  const q = (args.query ?? "").trim();
  if (!q) {
    // No query context — fall back to bulk load
    return loadActiveLearnings(args.repId, totalCeiling);
  }

  const { data, error } = await supabase.rpc("helper_learnings_search", {
    query_text: q.slice(0, 500),
    rep_scope: args.repId,
    limit_n: totalCeiling * 2,  // overfetch; we'll bucket-split below
  });
  if (error || !data) {
    console.warn("[helper-learnings] search RPC failed, falling back:", error?.message);
    return loadActiveLearnings(args.repId, totalCeiling);
  }

  const rows = data as HelperLearning[];
  const skills: HelperLearning[] = [];
  const memories: HelperLearning[] = [];
  for (const r of rows) {
    if (r.kind === "skill") skills.push(r);
    else memories.push(r);
  }

  // Skills: split into universal (always-on, no triggers) and triggered.
  // Universal skills are bot-infrastructure rules — they govern HOW Leon
  // acts at all, so they always load (e.g. "if you claim 记下了, you
  // must emit a tool block"). Triggered skills are domain-specific
  // procedures that should only fire when relevant — they get ranked
  // by (trigger-match bonus + FTS rank against body) and truncated.
  //
  // Total skill budget split: universal always loads (cap 10 to keep
  // prompt sane even if onboarding metastasizes); triggered fills the
  // remaining budget by score.
  const lowerQ = q.toLowerCase();
  const universalCap = Math.max(0, Math.min(10, Math.floor(skillBudget / 2)));
  const universalSkills = skills
    .filter((s) => !s.triggers || s.triggers.length === 0)
    .slice(0, universalCap);

  const triggeredSkillsScored = skills
    .filter((s) => s.triggers && s.triggers.length > 0)
    .map((s) => {
      const matchedTriggers = (s.triggers ?? []).filter((t) =>
        lowerQ.includes(t.toLowerCase()),
      );
      // Two-stage: skill activates ONLY if at least one trigger matched.
      // FTS rank is the tie-breaker WITHIN trigger-matched skills, not a
      // path to activation. This prevents skills from leaking in just
      // because their body happens to share a word with the query.
      return { skill: s, matchedCount: matchedTriggers.length, ftsRank: s.rank ?? 0 };
    })
    .filter((x) => x.matchedCount > 0)
    .sort((a, b) => {
      if (a.matchedCount !== b.matchedCount) return b.matchedCount - a.matchedCount;
      return b.ftsRank - a.ftsRank;
    });

  const triggeredBudget = Math.max(0, skillBudget - universalSkills.length);
  const activatedTriggered = triggeredSkillsScored
    .slice(0, triggeredBudget)
    .map((x) => x.skill);

  // Memories: rank-only. RPC already ordered by ts_rank_cd desc.
  const rankedMemories = memories
    .filter((m) => (m.rank ?? 0) > 0)
    .slice(0, memoryBudget);

  return [...universalSkills, ...activatedTriggered, ...rankedMemories];
}

export async function recordLearning(input: {
  scope_rep_id: number | null;
  kind: LearningKind;
  body: string;
  evidence?: unknown;
  confidence?: number;
  triggers?: string[];
}): Promise<HelperLearning | null> {
  const { data, error } = await supabase
    .from("helper_learnings")
    .insert({
      scope_rep_id: input.scope_rep_id,
      kind: input.kind,
      body: input.body.trim(),
      evidence: input.evidence ?? null,
      confidence: input.confidence ?? 0.5,
      triggers: input.triggers ?? [],
    })
    .select()
    .single();
  if (error) {
    console.warn("recordLearning failed:", error.message);
    return null;
  }
  const row = data as HelperLearning;

  // Post-insert: if this is a new skill that smells demo-able (has an
  // action verb + triggers), push admin a "want to smoke-test?" card.
  // Best-effort, non-blocking.
  if (row && row.kind === "skill") {
    try {
      const { suggestDemoForNewSkill } = await import("@/lib/skill-demo-suggester");
      void suggestDemoForNewSkill({
        learning_id: row.id,
        body: row.body,
        triggers: row.triggers ?? [],
        proposed_by_rep_id: row.scope_rep_id,
      });
    } catch (err) {
      console.warn("[recordLearning] demo-suggester hook failed:", err);
    }
  }
  return row;
}

/** Mark an existing learning as superseded — useful when reality contradicts it. */
export async function supersedeLearning(id: string): Promise<boolean> {
  const { error } = await supabase
    .from("helper_learnings")
    .update({ superseded_at: new Date().toISOString() })
    .eq("id", id);
  return !error;
}

/** Format learnings for inclusion in the helper's user prompt. */
export function formatLearningsForPrompt(learnings: HelperLearning[]): string {
  if (learnings.length === 0) return "";
  const grouped = new Map<LearningKind, HelperLearning[]>();
  for (const l of learnings) {
    const arr = grouped.get(l.kind) ?? [];
    arr.push(l);
    grouped.set(l.kind, arr);
  }
  const labels: Record<LearningKind, string> = {
    skill: "可激活的 skill (admin 让我下次这么做)",
    rep_pref: "rep 偏好",
    tactic: "战术经验",
    self_critique: "助手自检",
    other: "其他",
  };
  // Order matters — skills first so they're visually salient when the
  // model scans the system prompt.
  const order: LearningKind[] = ["skill", "rep_pref", "tactic", "self_critique", "other"];
  const sections: string[] = [];
  for (const kind of order) {
    const items = grouped.get(kind);
    if (!items?.length) continue;
    const lines = items.slice(0, 6).map((l) => `- ${l.body}`).join("\n");
    sections.push(`### ${labels[kind] ?? kind}\n${lines}`);
  }
  return `## 累积经验 (跨会话, 你之前从数据/对话里记下来的)\n${sections.join("\n\n")}\n`;
}
