// Multi-rep helper-question detector — when N reps ask the helper-bot
// about the same topic, that's a signal of a documentation/UI/tool gap
// admin should know about. Surfaces as an admin alert.
//
// Approach: pull recent user-role helper_messages, group by topic with
// one cheap LLM call, return clusters where ≥2 distinct reps asked.
// We don't try to do this client-side (TF-IDF on Chinese text would
// need a tokenizer); the LLM handles language + intent collapse.

import { supabase } from "@/lib/db";
import { llmChat } from "@/lib/llm-proxy";

const LOOKBACK_DAYS = 14;
const MIN_MESSAGES = 8;       // below this volume, clustering is noise
const MIN_REPS_PER_CLUSTER = 2;

export interface QuestionCluster {
  topic: string;          // short LLM-generated label
  rep_ids: number[];      // distinct reps who asked
  example_quotes: string[];  // 1-3 representative questions
  count: number;          // total messages in this cluster
  recency_days: number;   // days since most recent message in cluster
}

interface MsgWithRep {
  text: string;
  rep_id: number;
  created_at: string;
}

async function loadRecentUserMessages(): Promise<MsgWithRep[]> {
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();
  // Pull user messages joined to conversations for rep_id.
  const { data: msgs } = await supabase
    .from("helper_messages")
    .select("text, conversation_id, created_at")
    .eq("role", "user")
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(300);
  if (!msgs || msgs.length === 0) return [];
  const convIds = Array.from(new Set(msgs.map((m) => m.conversation_id as string)));
  const { data: convs } = await supabase
    .from("helper_conversations")
    .select("id, rep_id")
    .in("id", convIds);
  const repByConv = new Map<string, number>();
  for (const c of convs ?? []) repByConv.set(c.id as string, c.rep_id as number);
  const out: MsgWithRep[] = [];
  for (const m of msgs) {
    const repId = repByConv.get(m.conversation_id as string);
    const text = (m.text as string | null)?.trim();
    if (!repId || !text || text.length < 4) continue;
    out.push({ text: text.slice(0, 300), rep_id: repId, created_at: m.created_at as string });
  }
  return out;
}

const CLUSTER_SYSTEM = `你是一个产品经理 + UX 研究员的混合体。下面是销售在内部聊天助手里问的问题, 每条带 rep_id。

任务: 把意图相同 / 相近的问题归到一个 cluster。每个 cluster 给:
- topic: 一句话概括这群人在问什么 (中文, ≤20 字)
- example_quotes: 挑 1-3 句最有代表性的原话 (引号引起来)

返回 JSON 对象 { "clusters": [{ topic, message_indices: [int, int, ...] }] }, message_indices 是消息在输入数组中的 0-based 下标。

合并规则: 同一 rep 多次问同一件事算一次代表; 不同 rep 问同一个主题才有价值。如果输入数据太少 (≤5 条) 或没有任何重复主题, 返回 {"clusters":[]}。

只返回 JSON 对象, 不要其他文字。`;

export async function detectQuestionClusters(): Promise<QuestionCluster[]> {
  const msgs = await loadRecentUserMessages();
  if (msgs.length < MIN_MESSAGES) return [];

  // Format input for the LLM with stable indices.
  const lines = msgs.map((m, i) => `[${i}] (rep ${m.rep_id}) ${m.text}`).join("\n");
  let raw = "";
  try {
    const r = await llmChat({
      model: "claude-opus-4.7",
      system: CLUSTER_SYSTEM,
      user: `共 ${msgs.length} 条消息:\n\n${lines}\n\n找 cluster。`,
      temperature: 0.1,
      max_tokens: 2000,
      json: true,
      timeoutMs: 60_000,
    });
    raw = r.text;
  } catch {
    return [];
  }
  let parsed: { clusters?: Array<{ topic?: string; message_indices?: number[] }> } = {};
  try {
    parsed = JSON.parse(raw.replace(/^```(json)?\s*/, "").replace(/```\s*$/, "").trim());
  } catch {
    return [];
  }
  const clusters = parsed.clusters ?? [];
  const out: QuestionCluster[] = [];
  for (const c of clusters) {
    const indices = (c.message_indices ?? []).filter((i) => Number.isInteger(i) && i >= 0 && i < msgs.length);
    if (indices.length === 0) continue;
    const repIds = Array.from(new Set(indices.map((i) => msgs[i].rep_id)));
    if (repIds.length < MIN_REPS_PER_CLUSTER) continue;
    const examples = indices.slice(0, 3).map((i) => `"${msgs[i].text.slice(0, 120)}"`);
    const newestMs = Math.max(...indices.map((i) => new Date(msgs[i].created_at).getTime()));
    out.push({
      topic: (c.topic ?? "(no label)").slice(0, 80),
      rep_ids: repIds,
      example_quotes: examples,
      count: indices.length,
      recency_days: Math.floor((Date.now() - newestMs) / 86_400_000),
    });
  }
  // Sort by rep count desc — broadest pain comes first.
  out.sort((a, b) => b.rep_ids.length - a.rep_ids.length || b.count - a.count);
  return out.slice(0, 5);
}
