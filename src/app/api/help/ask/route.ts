import { NextRequest, NextResponse } from "next/server";
import { llmChat } from "@/lib/llm-proxy";
import { QIJI_PROGRAM_FACTS } from "@/lib/qiji-facts";
import { SALES_GUIDE } from "@/lib/sales-guide-corpus";
import { requireSession } from "@/lib/auth-helpers";
import { supabase } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/help/ask
 * Body: {
 *   question: string,
 *   currentPath?: string,
 *   history?: {role, text}[],      // fallback when no conversationId
 *   conversationId?: string,       // persists messages if provided
 * }
 *
 * Sales Helper — answers app + script questions AND can emit
 * tool proposals for destructive actions (batch-send, skip, etc).
 *
 * Tool-use pattern:
 *   - LLM is told about available tools via the system prompt.
 *   - When the user asks for an action ("send top 20 strong leads"),
 *     the LLM returns JSON with a `tool_proposal` field instead of
 *     (or alongside) prose.
 *   - Client renders a confirm card; user clicks Confirm → POST to
 *     /api/help/execute which actually performs the action.
 *   - NO action is taken server-side from this endpoint. This endpoint
 *     only SUGGESTS. That way a hallucinated "send 1000 emails"
 *     response can never actually send anything without a human click.
 *
 * Persistence:
 *   - If `conversationId` is provided AND owned by the session's rep,
 *     both the user message and the assistant reply are appended to
 *     helper_messages and the conversation's updated_at is bumped.
 *   - If not provided, the endpoint behaves ephemerally (no DB writes)
 *     — same as before this change, so existing callers keep working.
 */

const SYSTEM = `你是 Qiji Pipeline 的销售助手 (Sales Copilot)。

你的工作分三类：
1. **怎么用 app** — 用户问"X 在哪里"/"怎么 Y" → 看 Sales Guide 回答, 给具体路径
2. **对方问什么怎么答** — 用户问"对方问 X 我怎么回" → 看 Qiji Compute facts, 给可以照着说的中文话术
3. **执行操作** — 用户说"发前20个强 lead" / "把这个 lead skip" 之类的指令 → 你可以**建议**一个操作, UI 会弹确认卡让用户决定是否执行

## 回答风格
- 中文, 口语化, 短
- 直接给答案 + 1-2 句铺垫, 不要长篇大论
- 多种答法用 1./2./3. 列出
- 不要 markdown 标题
- 引用 UI 元素时用粗体 (**Pipeline** **Review** **Send** 等)

## 绝对原则
- 这是「奇绩算力 (Compute)」program。**严禁**回答「奇绩创业营 (Accelerator)」相关问题（投资金额/股权比例/batch 时间/北京线下营等）。
  → 被问到创业营时回答："那是另一个程序，我帮你转给 mentor team 详细聊。"
- 不要瞎编数字、政策、流程。不确定就说"这个我也不太确定，找 Xingze 确认"。
- 不要承诺超出 facts 的东西。

## 工具 (仅在用户明确要求执行操作时使用)

你的回答可以是纯文本，或者是一个包含 tool_proposal 的 JSON 块。决定规则：
- 用户问问题 (怎么做/怎么答/什么是 X) → 纯文本
- 用户说"发 N 个 lead" / "skip 这个" / "flag 这个" → 在回答末尾加 tool_proposal

**格式**: 当需要建议一个操作时，你的回答最后一行必须是：

\`\`\`tool
{"action": "batch_send", "filter": "strong", "limit": 20}
\`\`\`

可用 actions:
- batch_send — 批量发邮件. 参数: { filter: "all" | "strong" | "normal", limit: number (最多50) }
- skip_lead — 跳过一个 lead. 参数: { lead_id: string }
- flag_lead — 标记一个 lead. 参数: { lead_id: string, type: "bad_compute"|"wrong_author"|"wrong_direction"|"low_quality_email"|"right_lead_wrong_pitch"|"good_lead", severity: "soft"|"hard", reason?: string }

**重要**: 你只提议, 不执行. UI 会显示确认卡, 用户点 Confirm 才真发.
如果用户的指令模糊 (比如"发一些"没说数量), 先问清楚, 不要猜数字.`;

type HistMsg = { role: "user" | "assistant"; text: string };

interface ToolProposal {
  action: string;
  [key: string]: unknown;
}

function extractToolProposal(text: string): { cleaned: string; proposal: ToolProposal | null } {
  // Look for fenced ```tool ... ``` block at the tail. If missing, return text as-is.
  const m = text.match(/```tool\s*\n([\s\S]*?)\n```/);
  if (!m) return { cleaned: text, proposal: null };
  let proposal: ToolProposal | null = null;
  try {
    const parsed = JSON.parse(m[1].trim());
    if (parsed && typeof parsed === "object" && typeof parsed.action === "string") {
      // Clamp batch_send limit
      if (parsed.action === "batch_send" && typeof parsed.limit === "number") {
        parsed.limit = Math.max(1, Math.min(50, Math.floor(parsed.limit)));
      }
      proposal = parsed;
    }
  } catch {
    // bad JSON — treat as no proposal
  }
  const cleaned = text.replace(/```tool\s*\n[\s\S]*?\n```/, "").trim();
  return { cleaned, proposal };
}

export async function POST(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const question = String(body.question ?? "").trim();
  const currentPath = String(body.currentPath ?? "").trim();
  const inlineHistory: HistMsg[] = Array.isArray(body.history) ? body.history.slice(-4) : [];
  const conversationId = typeof body.conversationId === "string" ? body.conversationId : null;

  if (!question) return NextResponse.json({ error: "question required" }, { status: 400 });
  if (question.length > 500) return NextResponse.json({ error: "question too long (max 500 chars)" }, { status: 400 });

  // Verify + fetch history from persisted conversation if provided.
  // Otherwise fall back to the inline history sent by the client.
  let history: HistMsg[] = inlineHistory;
  if (conversationId) {
    const { data: conv } = await supabase
      .from("helper_conversations")
      .select("id, rep_id")
      .eq("id", conversationId)
      .maybeSingle();
    if (!conv || conv.rep_id !== session.repId) {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }
    const { data: prior } = await supabase
      .from("helper_messages")
      .select("role, text")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .limit(20);
    history = ((prior ?? []) as HistMsg[])
      .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.text === "string" && m.text.length > 0)
      .slice(-8);
  }

  const historyText = history.length > 0
    ? "\n## 上文对话\n" + history.map((m) =>
        `${m.role === "user" ? "用户" : "助手"}: ${String(m.text).slice(0, 600)}`
      ).join("\n") + "\n"
    : "";

  const pathHint = currentPath
    ? `\n用户当前在页面: ${currentPath}\n（"这里"/"这个页面"指的是这个路径。）\n`
    : "";

  const user = `## Sales Guide
${SALES_GUIDE}

## Qiji Compute Facts
${QIJI_PROGRAM_FACTS}
${pathHint}${historyText}
## 用户问题
${question}

请回答。`;

  let answer = "";
  let model = "";
  try {
    const r = await llmChat({
      model: "gemini-3-flash",
      system: SYSTEM,
      user,
      temperature: 0.4,
      max_tokens: 1000,
      timeoutMs: 25_000,
    });
    answer = r.text.trim();
    model = "gemini-3-flash";
  } catch {
    try {
      const r = await llmChat({
        model: "gemini-3-pro",
        system: SYSTEM,
        user,
        temperature: 0.4,
        max_tokens: 1000,
        timeoutMs: 25_000,
      });
      answer = r.text.trim();
      model = "gemini-3-pro";
    } catch (e2) {
      return NextResponse.json(
        { error: `LLM unavailable: ${e2 instanceof Error ? e2.message : String(e2)}` },
        { status: 502 },
      );
    }
  }

  const { cleaned, proposal } = extractToolProposal(answer);

  // Persist if conversationId given.
  if (conversationId) {
    const now = new Date().toISOString();
    await supabase.from("helper_messages").insert([
      { conversation_id: conversationId, role: "user", text: question },
      { conversation_id: conversationId, role: "assistant", text: cleaned, tool_proposal: proposal },
    ]);
    await supabase
      .from("helper_conversations")
      .update({ updated_at: now, title: history.length === 0 ? question.slice(0, 120) : undefined })
      .eq("id", conversationId);
  }

  return NextResponse.json({ answer: cleaned, proposal, model });
}
