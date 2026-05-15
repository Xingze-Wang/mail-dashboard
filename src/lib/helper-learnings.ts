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
}

/** Active (non-superseded) learnings for a rep, with org-wide ones too. */
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

export async function recordLearning(input: {
  scope_rep_id: number | null;
  kind: LearningKind;
  body: string;
  evidence?: unknown;
  confidence?: number;
}): Promise<HelperLearning | null> {
  const { data, error } = await supabase
    .from("helper_learnings")
    .insert({
      scope_rep_id: input.scope_rep_id,
      kind: input.kind,
      body: input.body.trim(),
      evidence: input.evidence ?? null,
      confidence: input.confidence ?? 0.5,
    })
    .select()
    .single();
  if (error) {
    console.warn("recordLearning failed:", error.message);
    return null;
  }
  return data as HelperLearning;
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
