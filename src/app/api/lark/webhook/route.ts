import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { llmChat } from "@/lib/llm-proxy";
import { TOOLS_PROMPT, type ToolProposal } from "@/lib/helper-tools";
import { runReadTool, extractReadToolCalls, stripReadToolCalls } from "@/lib/helper-read-tools";
import { recordLearning } from "@/lib/helper-learnings";
import { QIJI_PROGRAM_FACTS } from "@/lib/qiji-facts";
import { SALES_GUIDE } from "@/lib/sales-guide-corpus";
import {
  verifyLarkEvent,
  extractText,
  extractChatId,
  extractMessageId,
  extractSenderOpenId,
  resolveRepFromOpenId,
  sendMessage,
} from "@/lib/lark";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Lark expects fast 200s on its webhook. We acknowledge immediately and
// process the actual reply async via setImmediate / setTimeout(0). If the
// reply takes >10s Lark will already have closed the connection but our
// outbound `sendMessage` doesn't depend on the inbound response.

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

// ─── Inner: call LLM with bounded agent loop ────────────────────────────

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
    console.error("[lark] llm error", err);
    return { text: "(LLM error — try again)", model: "error" };
  }
}

// Strip the action-tool ```tool``` block from a Lark reply. Action tools
// require user-confirm UI cards which Lark doesn't have, so we remove them
// and add a one-line note pointing the rep to the web app.
//
// Exception: `remember_about_rep` is non-destructive (just writes a memory
// row) and getting Lark to write to long-term memory is the v1.5 win that
// makes the bot stop being stateless. We auto-execute it inline and tell
// the rep what got remembered. Other actions still strip.
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

/**
 * Auto-execute the small set of non-destructive proposals in Lark.
 * Returns a confirmation suffix to append to the reply, or null if the
 * proposal isn't auto-executable (caller should append "do this on web").
 */
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
    console.error("[lark] memory write failed", err);
    return null;
  }
}

/**
 * Pull the most recent ~6 cross-surface helper_messages for this rep so
 * the Lark bot has continuity with what was discussed on /pipeline. We
 * only pull when the user message references prior conversation — by
 * default the per-thread Lark history is enough and pulling extra context
 * just bloats the prompt.
 */
function userMentionsPriorContext(text: string): boolean {
  const cues = ["之前", "上次", "刚才", "earlier", "you said", "前面", "刚刚", "你之前"];
  const lower = text.toLowerCase();
  return cues.some((c) => lower.includes(c));
}

async function loadCrossSurfaceHistory(repId: number, limit = 6): Promise<{ role: "user" | "assistant"; text: string }[]> {
  // Most recent web-side helper_messages for this rep, joining via
  // helper_conversations to scope. Only the last `limit` turns.
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

// LarkSession matches the Session type expected by helper-read-tools.ts:
// `{ repId: number; role: string; repName?: string; email?: string }`
interface LarkSession {
  repId: number;
  role: "admin" | "senior" | "sales";
  repName?: string;
  email?: string;
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

// ─── Webhook handler ────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  // Verify signature
  const verify = verifyLarkEvent({
    rawBody,
    timestamp: req.headers.get("x-lark-request-timestamp"),
    nonce: req.headers.get("x-lark-request-nonce"),
    signature: req.headers.get("x-lark-signature"),
  });
  if (!verify.ok) {
    console.error("[lark/webhook] signature failed:", verify.reason);
    return NextResponse.json({ error: verify.reason }, { status: 401 });
  }

  let body: { type?: string; challenge?: string; encrypt?: string; event?: unknown; header?: { event_type?: string } };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  // 1. URL verification challenge — Lark calls this once when you set
  // the webhook URL in the Open Platform console. Echo the challenge.
  if (body.type === "url_verification" && body.challenge) {
    return NextResponse.json({ challenge: body.challenge });
  }

  // 2. Encrypted payload — not supported yet
  if (body.encrypt) {
    console.error("[lark/webhook] encrypted body not supported (set encrypt_key off in app)");
    return NextResponse.json({ ok: false, reason: "encrypt not supported" }, { status: 200 });
  }

  // 3. Event dispatch (v2 wraps it in { header, event })
  const eventType = body.header?.event_type ?? body.type ?? "";
  if (!eventType.startsWith("im.message.receive_v1") && !eventType.startsWith("im.message")) {
    return NextResponse.json({ ok: true, skipped: eventType }, { status: 200 });
  }

  const event = body.event;
  if (!event) return NextResponse.json({ ok: true, skipped: "no event" }, { status: 200 });

  const text = extractText(event);
  const chatId = extractChatId(event);
  const messageId = extractMessageId(event);
  const senderOpenId = extractSenderOpenId(event);

  if (!text || !chatId || !senderOpenId) {
    return NextResponse.json({ ok: true, skipped: "incomplete event" }, { status: 200 });
  }

  // 4. Resolve sender → rep
  const rep = await resolveRepFromOpenId(senderOpenId);
  if (!rep) {
    // Unknown sender — reply with onboarding
    await sendMessage({
      receive_id: chatId,
      receive_id_type: "chat_id",
      text: `Hi! 我不认识你 (Lark open_id: ${senderOpenId.slice(0, 12)}...). 找 Xingze 把你绑定到 sales_reps 表 (lark_open_id 列), 之后就能聊了.`,
    });
    return NextResponse.json({ ok: true, action: "onboarding-reply" }, { status: 200 });
  }

  // 5. Persist user message + load short history
  await supabase.from("lark_messages").insert({
    chat_id: chatId,
    message_id: messageId,
    rep_id: rep.id,
    role: "user",
    text,
    raw: body,
  });
  const { data: priorRows } = await supabase
    .from("lark_messages")
    .select("role, text")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(8);
  const larkHistory = (priorRows ?? []).reverse().slice(0, -1) as { role: "user" | "assistant"; text: string }[];

  // v1.5: cross-surface continuity. Only pull web history when the user
  // signals they're referring to prior conversation ("之前 / 上次 / earlier" etc.)
  // — otherwise the per-thread Lark history is enough and we save context.
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

  // 6. Run the agent — async so we can ack the webhook fast
  // Lark expects a 200 within ~3s; the LLM call takes 5-15s. Fire-and-forget
  // the reply, return immediately.
  const session: LarkSession = {
    repId: rep.id,
    role: rep.role,
    repName: rep.name,
    email: rep.email,
  };
  (async () => {
    try {
      const reply = await runAgent(session, text, history);
      const { cleaned, proposal } = extractAnyProposal(reply);

      // If the model proposed remember_about_rep, auto-execute (non-destructive).
      // Other proposals get "do this on web" advice and the action stays stripped.
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

      await sendMessage({
        receive_id: chatId,
        receive_id_type: "chat_id",
        text: finalReply,
      });
      await supabase.from("lark_messages").insert({
        chat_id: chatId,
        rep_id: rep.id,
        role: "assistant",
        text: finalReply,
      });
    } catch (err) {
      console.error("[lark/webhook] agent error", err);
      await sendMessage({
        receive_id: chatId,
        receive_id_type: "chat_id",
        text: "(出错了, 让 Xingze 看一下日志)",
      }).catch(() => {});
    }
  })();

  return NextResponse.json({ ok: true }, { status: 200 });
}

// Health check — useful for confirming the deployment serves this route
export async function GET() {
  return NextResponse.json({
    ok: true,
    route: "/api/lark/webhook",
    config: {
      app_id_set: !!process.env.LARK_APP_ID,
      app_secret_set: !!process.env.LARK_APP_SECRET,
      verification_token_set: !!process.env.LARK_VERIFICATION_TOKEN,
      region: process.env.LARK_REGION === "cn" ? "cn" : "global",
    },
  });
}
