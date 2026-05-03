// Shared inbound-message processor for the Lark bot.
//
// Both transports — the HTTP webhook (src/app/api/lark/webhook/route.ts)
// and the long-connection WebSocket worker (scripts/lark-bot-worker.mjs)
// — call processInboundLarkMessage(event) with the same Lark v2
// im.message.receive_v1 event payload. This keeps agent behavior
// (system prompt, tool loop, history merging, memory writes) identical
// across transports so we never have to reason about "which one is
// stale."
//
// The webhook calls this from inside next/server's after() so the 200
// ack returns instantly. The WS worker calls it directly — long-conn
// mode also wants <3s ack from the SDK callback.

import { supabase } from "@/lib/db";
import { llmChat } from "@/lib/llm-proxy";
import { TOOLS_PROMPT, type ToolProposal } from "@/lib/helper-tools";
import { runReadTool, extractReadToolCalls, stripReadToolCalls } from "@/lib/helper-read-tools";
import { recordLearning } from "@/lib/helper-learnings";
import { QIJI_PROGRAM_FACTS } from "@/lib/qiji-facts";
import { SALES_GUIDE } from "@/lib/sales-guide-corpus";
import {
  extractText,
  extractChatId,
  extractMessageId,
  extractSenderOpenId,
  resolveRepFromOpenId,
  sendMessage,
} from "@/lib/lark";

const SYSTEM_BASE = `你是 Qiji 算力 program 的销售搭档. Lark 里的同事在跟你聊天.

## 语气
- 中文为主, 技术词保留英文 (lead, ready, override, send, batch).
- 句子要有用. 简单问题一句话, 复杂问题该说清楚就说清楚.
- 不用 emoji, 不用 "您", 不用 "请问".
- 决策明确 ("要不要"), 不要 "建议你考虑".

## 上下文
- 这是 Lark 频道, 不是网页 panel. UI 操作建议用文字描述, 让 rep 去网页执行.
- 涉及数字或具体 lead → 必须先 lookup, 不要凭印象答.
- 不要在聊天里写完整邮件正文. 改草稿建议 rep 去 /review 模式操作.
- 不瞎编数字. 不确定就说 "不确定, 找 Xingze".

## 严禁
- 不能回答「奇绩创业营」相关 (投资额 / 股权 / batch). 这是「奇绩算力」program.
`;

interface LarkSession {
  repId: number;
  role: "admin" | "senior" | "sales";
  repName?: string;
  email?: string;
}

async function callLLM(system: string, user: string): Promise<{ text: string; model: string }> {
  try {
    const r = await llmChat({
      model: "gemini-3-flash",
      system,
      user,
      temperature: 0.4,
      max_tokens: 1500,
    });
    return { text: r.text ?? "(empty)", model: r.meta?.model ?? "gemini-3-flash" };
  } catch (err) {
    console.error("[lark-agent] llm error", err);
    return { text: "(LLM error — try again)", model: "error" };
  }
}

function extractAnyProposal(text: string): { cleaned: string; proposal: ToolProposal | null } {
  const m = text.match(/```tool\s*\n([\s\S]*?)\n```/);
  if (!m) return { cleaned: text, proposal: null };
  const cleaned = text.replace(/```tool\s*\n[\s\S]*?\n```/, "").trim();
  try {
    const parsed = JSON.parse(m[1].trim());
    if (parsed && typeof parsed === "object" && typeof parsed.action === "string") {
      return { cleaned, proposal: parsed as ToolProposal };
    }
  } catch { /* fall through */ }
  return { cleaned, proposal: null };
}

async function autoExecuteSafeProposal(
  session: LarkSession,
  proposal: ToolProposal,
): Promise<string | null> {
  if (proposal.action !== "remember_about_rep") return null;
  const kindRaw = typeof proposal.kind === "string" ? proposal.kind : "other";
  const allowed = ["rep_pref", "tactic", "self_critique", "other"] as const;
  type Kind = (typeof allowed)[number];
  const kind: Kind = (allowed as readonly string[]).includes(kindRaw) ? (kindRaw as Kind) : "other";
  const body = typeof proposal.body === "string" ? proposal.body.trim() : "";
  if (!body || body.length < 3 || body.length > 600) return null;
  const scope = proposal.scope === "org" && session.role === "admin" ? "org" : "rep";
  const scope_rep_id = scope === "org" ? null : session.repId;
  try {
    const learning = await recordLearning({
      scope_rep_id,
      kind,
      body,
      confidence: 0.8,
      evidence: { source: "lark_chat", session_rep: session.repId },
    });
    if (!learning) return null;
    return `\n\n— 记下来了 (kind: ${kind}): ${body.slice(0, 120)}${body.length > 120 ? "..." : ""}`;
  } catch (err) {
    console.error("[lark-agent] memory write failed", err);
    return null;
  }
}

function userMentionsPriorContext(text: string): boolean {
  const cues = ["之前", "上次", "刚才", "earlier", "you said", "前面", "刚刚", "你之前"];
  const lower = text.toLowerCase();
  return cues.some((c) => lower.includes(c));
}

async function loadCrossSurfaceHistory(repId: number, limit = 6): Promise<{ role: "user" | "assistant"; text: string }[]> {
  const { data, error } = await supabase
    .from("helper_messages")
    .select("role, text, created_at, helper_conversations!inner(rep_id)")
    .eq("helper_conversations.rep_id", repId)
    .in("role", ["user", "assistant"])
    .not("text", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return (data as { role: string; text: string }[])
    .reverse()
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.text === "string" && m.text.length > 0)
    .map((m) => ({ role: m.role as "user" | "assistant", text: m.text }));
}

const MAX_ITERATIONS = 3;

async function runAgent(session: LarkSession, question: string, history: { role: "user" | "assistant"; text: string }[]): Promise<string> {
  const histText = history.length > 0
    ? "\n## 上文对话\n" + history.slice(-6).map((m) => `${m.role === "user" ? "用户" : "助手"}: ${m.text.slice(0, 600)}`).join("\n") + "\n"
    : "";

  const system = SYSTEM_BASE + "\n" + TOOLS_PROMPT;
  let userPrompt = `## 参考资料 — Sales Guide
${SALES_GUIDE.slice(0, 2500)}

## 参考资料 — Qiji Compute Facts
${QIJI_PROGRAM_FACTS.slice(0, 2500)}
${histText}
## 用户问题 (来自 Lark, rep=${session.repName}, role=${session.role})
${question}

记住: 涉及具体数字或具体 lead 时, 必须先 \`\`\`lookup\`\`\`.`;

  let finalText = "";
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const { text } = await callLLM(system, userPrompt);
    const calls = extractReadToolCalls(text);
    if (calls.length === 0) {
      finalText = text;
      break;
    }
    const results = await Promise.all(calls.map((c) => runReadTool(session, c)));
    const summary = results.map((r, i) =>
      `### ${calls[i].tool}(${JSON.stringify(calls[i].args)}) →\n${JSON.stringify(r.result).slice(0, 3500)}`
    ).join("\n\n");
    userPrompt = `${userPrompt}\n\n## 工具查询结果 (round ${iter + 1})\n${summary}\n\n基于真实数据回答用户. 最后一轮直接给最终回答.`;
    if (iter === MAX_ITERATIONS - 1) {
      const { text: final } = await callLLM(system, userPrompt + "\n\n这是最后一轮, 必须给最终回答, 不要再 lookup.");
      finalText = stripReadToolCalls(final);
    }
  }
  if (!finalText) finalText = "(无回答)";
  return stripReadToolCalls(finalText);
}

/**
 * Process one inbound Lark message event end-to-end. Idempotent on
 * message_id (Lark redelivers if we don't ack in 3s, and the long-conn
 * SDK has its own at-least-once semantics).
 *
 * `rawEvent` is the full envelope (`{ schema, header, event }` for v2).
 * `transport` is just for logging — distinguishes webhook vs ws so we
 * can debug duplicates if they happen.
 */
export async function processInboundLarkMessage(
  rawEvent: unknown,
  transport: "webhook" | "ws",
): Promise<{ ok: boolean; reason?: string }> {
  const env = rawEvent as { event?: unknown };
  const event = env.event ?? rawEvent; // ws SDK passes the inner event directly

  const text = extractText(event);
  const chatId = extractChatId(event);
  const messageId = extractMessageId(event);
  const senderOpenId = extractSenderOpenId(event);

  if (!text || !chatId || !senderOpenId) {
    return { ok: true, reason: "incomplete event" };
  }

  // Idempotency: if we've already stored this message_id, skip. Avoids
  // duplicate replies when Lark redelivers (3s ack timeout, ws reconnect).
  if (messageId) {
    const { data: existing } = await supabase
      .from("lark_messages")
      .select("id")
      .eq("message_id", messageId)
      .maybeSingle();
    if (existing) {
      return { ok: true, reason: "duplicate message_id" };
    }
  }

  const rep = await resolveRepFromOpenId(senderOpenId);
  if (!rep) {
    await supabase.from("lark_messages").insert({
      chat_id: chatId,
      message_id: messageId,
      rep_id: null,
      role: "user",
      text,
      raw: rawEvent,
    });
    await sendMessage({
      receive_id: chatId,
      receive_id_type: "chat_id",
      text: `Hi! 我不认识你 (Lark open_id: ${senderOpenId.slice(0, 12)}...). 找 Xingze 把你绑定到 sales_reps 表 (lark_open_id 列), 之后就能聊了.`,
    }).catch((e) => console.error(`[lark-agent/${transport}] onboarding sendMessage failed`, e));
    return { ok: true, reason: "onboarding-reply" };
  }

  await supabase.from("lark_messages").insert({
    chat_id: chatId,
    message_id: messageId,
    rep_id: rep.id,
    role: "user",
    text,
    raw: rawEvent,
  });

  const { data: priorRows } = await supabase
    .from("lark_messages")
    .select("role, text")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(8);
  const larkHistory = (priorRows ?? []).reverse().slice(0, -1) as { role: "user" | "assistant"; text: string }[];

  let history = larkHistory;
  if (userMentionsPriorContext(text)) {
    const webHist = await loadCrossSurfaceHistory(rep.id, 4);
    if (webHist.length > 0) {
      history = [
        ...webHist.map((m) => ({ ...m, text: `[web] ${m.text}` })),
        ...larkHistory,
      ];
    }
  }

  const session: LarkSession = {
    repId: rep.id,
    role: rep.role,
    repName: rep.name,
    email: rep.email,
  };

  const reply = await runAgent(session, text, history);
  const { cleaned, proposal } = extractAnyProposal(reply);

  let suffix = "";
  if (proposal) {
    const memorySuffix = await autoExecuteSafeProposal(session, proposal);
    if (memorySuffix) {
      suffix = memorySuffix;
    } else {
      suffix = "\n\n— 这步要在网页 /pipeline 里点 confirm 才会执行, Lark 里只能讨论.";
    }
  }
  const finalReply = (cleaned + suffix).trim() || "(空)";

  // Persist BEFORE sendMessage so we have proof the agent worked even
  // if the outbound Lark call fails (network blip, expired token,
  // synthetic chat in tests). The smoke harness reads this row.
  await supabase.from("lark_messages").insert({
    chat_id: chatId,
    rep_id: rep.id,
    role: "assistant",
    text: finalReply,
  });
  await sendMessage({
    receive_id: chatId,
    receive_id_type: "chat_id",
    text: finalReply,
  }).catch((e) => console.error(`[lark-agent/${transport}] reply sendMessage failed`, e));

  return { ok: true };
}
