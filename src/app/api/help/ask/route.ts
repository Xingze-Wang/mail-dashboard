import { NextRequest, NextResponse } from "next/server";
import { llmChat } from "@/lib/llm-proxy";
import { QIJI_PROGRAM_FACTS } from "@/lib/qiji-facts";
import { SALES_GUIDE } from "@/lib/sales-guide-corpus";
import { requireSession } from "@/lib/auth-helpers";
import { supabase } from "@/lib/db";
import { TOOLS_PROMPT, ACTION_TOOL_NAMES } from "@/lib/helper-tools";
import type { ToolProposal } from "@/lib/helper-tools";
import {
  runReadTool,
  extractReadToolCalls,
  stripReadToolCalls,
} from "@/lib/helper-read-tools";

export const dynamic = "force-dynamic";
export const maxDuration = 60;  // agent loop may take 2 LLM round-trips

/**
 * POST /api/help/ask
 *
 * Agent loop:
 *   1. LLM turn 1: sees user question + tools catalog. May emit
 *      ```lookup ...``` blocks (read-only, auto-run) and/or a
 *      ```tool ...``` proposal (destructive, user must confirm).
 *   2. If lookup blocks present, we execute them server-side and
 *      feed results back in a 2nd prompt. LLM produces final answer.
 *   3. Up to MAX_ITERATIONS rounds, then force a final answer.
 *
 * Persistence unchanged: if conversationId provided and owned by
 * session's rep, messages + tool_proposal are stored.
 */

const MAX_ITERATIONS = 3;

const SYSTEM_BASE = `你是 rep 的搭档. 像一个有分寸的同事, 不是客服机器人.

## 语气规则 (硬规则)
- 中文为主, 技术词保留英文 (override, ready, queue, lead, batch, Pipeline, Review).
- 每句话都要有用. 该解释就解释, 该说清楚就说清楚, 不灌水但也不要硬压成一句话. 问题复杂就多说几句, 问题简单就一句话答完.
- 事实第一, 情绪第二.
- **不用** emoji.
- **不用** 语气词 ("哈" "呀" "呢" "哦" "嘿" "诶" "啦").
- **不用** 敬称 ("您" "请问").
- 要决策明确 ("要不要 / 要吗"), 不要 "建议" "不妨" "可以考虑".
- 没话说就不说, 别硬聊.

## 上下文感知 (重要)
根据问题+当前情境自己判断走哪条路线, 不问 rep "你想干嘛":

1. **rep 在 Review 模式 (context 有 current_lead)** + 问题是关于这篇 paper ("这篇在做什么" "为啥需要算力") → 解释 paper 本身.
2. 问题是具体 lead 操作 ("发这个" "skip 这条" "重写") → 先 lookup 确定 lead id, 再用工具.
3. 问题是数字 ("我今天还能发几个" "还剩多少 override") → 必须先 lookup.
4. 问题是 app 操作 ("怎么发邮件" "Send 在哪") → 看 Sales Guide 答, 不用工具.
5. 问题是话术 ("对方说 NSF grant 怎么回") → 看 Qiji facts 答.
6. 问题模糊 → 用一句话反问清楚, 不要猜.

## 绝对原则
- 这是「奇绩算力」program. 严禁回答「奇绩创业营」相关 (投资额 / 股权 / batch 时间).
- 不瞎编数字, 不确定就说 "不确定, 找 Xingze".
- **不要在聊天里直接写完整邮件正文**. 要改草稿只能通过 redraft_lead 工具 (propose + confirm 流程).

## 语言
- 默认中文.
- 如果用户说 "英文回答" / "switch to english" / 用英文提问 → 之后都用英文回答, 直到用户改回来.
- 如果用户说 "帮我翻译 X" / "用英文说这段" → 直接翻译, 不用工具, 不要啰嗦.
- 换语言不需要用户点按钮, 直接说就行.
`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extractToolProposal(text: string): { cleaned: string; proposal: ToolProposal | null; proposalError: string | null } {
  const m = text.match(/```tool\s*\n([\s\S]*?)\n```/);
  if (!m) return { cleaned: text, proposal: null, proposalError: null };
  const cleaned = text.replace(/```tool\s*\n[\s\S]*?\n```/, "").trim();
  let proposal: ToolProposal | null = null;
  let proposalError: string | null = null;
  try {
    const parsed = JSON.parse(m[1].trim());
    if (!parsed || typeof parsed !== "object" || typeof parsed.action !== "string") {
      proposalError = "proposal missing action";
    } else if (!ACTION_TOOL_NAMES.has(parsed.action)) {
      proposalError = `unknown action: ${parsed.action}`;
    } else {
      // Validate and clamp per-action args. A bad lead_id (name instead
      // of UUID) is a common LLM error; reject it up front so the user
      // sees "helper tried to act on 'Yanye' — need to look up first"
      // rather than a downstream 404.
      if ((parsed.action === "skip_lead" || parsed.action === "flag_lead" || parsed.action === "redraft_lead" || parsed.action === "open_split_view")) {
        if (typeof parsed.lead_id !== "string" || !UUID_RE.test(parsed.lead_id)) {
          proposalError = `invalid lead_id (not a UUID): ${parsed.lead_id ?? "null"}. Helper needs to look up first.`;
        }
      }
      if (parsed.action === "bulk_flag") {
        if (!Array.isArray(parsed.lead_ids) || parsed.lead_ids.length === 0) {
          proposalError = "bulk_flag needs lead_ids[]";
        } else {
          const bad = parsed.lead_ids.find((id: unknown) => typeof id !== "string" || !UUID_RE.test(id as string));
          if (bad !== undefined) proposalError = `bulk_flag has non-UUID id: ${String(bad).slice(0, 40)}`;
          else parsed.lead_ids = parsed.lead_ids.slice(0, 20);
        }
      }
      if (parsed.action === "batch_send" && typeof parsed.limit === "number") {
        parsed.limit = Math.max(1, Math.min(50, Math.floor(parsed.limit)));
      }
      if (!proposalError) proposal = parsed;
    }
  } catch {
    proposalError = "proposal JSON parse failed";
  }
  return { cleaned, proposal, proposalError };
}

type HistMsg = { role: "user" | "assistant"; text: string };

async function callLLM(system: string, user: string): Promise<{ text: string; model: string }> {
  try {
    const r = await llmChat({
      model: "gemini-3-flash",
      system,
      user,
      temperature: 0.4,
      max_tokens: 1500,
      timeoutMs: 25_000,
    });
    return { text: r.text.trim(), model: "gemini-3-flash" };
  } catch {
    const r = await llmChat({
      model: "gemini-3-pro",
      system,
      user,
      temperature: 0.4,
      max_tokens: 1500,
      timeoutMs: 25_000,
    });
    return { text: r.text.trim(), model: "gemini-3-pro" };
  }
}

export async function POST(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const question = String(body.question ?? "").trim();
  const currentPath = String(body.currentPath ?? "").trim();
  const inlineHistory: HistMsg[] = Array.isArray(body.history) ? body.history.slice(-4) : [];
  const conversationId = typeof body.conversationId === "string" ? body.conversationId : null;
  // Current review lead — passed by the HelpBot when rep is in Review
  // mode. The agent uses this to route paper questions without needing
  // a separate "Paper Tutor" mode.
  const currentLeadId = typeof body.currentLeadId === "string" ? body.currentLeadId : null;

  if (!question) return NextResponse.json({ error: "question required" }, { status: 400 });
  if (question.length > 500) return NextResponse.json({ error: "question too long" }, { status: 400 });

  // Resolve history from persisted conversation if given.
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
  const pathHint = currentPath ? `\n用户当前在页面: ${currentPath}\n` : "";

  // Fetch a lite current-lead snapshot so paper questions can be
  // answered without a lookup round-trip. Ownership enforced: we
  // don't leak another rep's lead data via the helper.
  let currentLeadHint = "";
  if (currentLeadId) {
    const { data: lead } = await supabase
      .from("pipeline_leads")
      .select("id, title, author_name, abstract, assigned_rep_id")
      .eq("id", currentLeadId)
      .maybeSingle();
    if (lead && (session.role === "admin" || lead.assigned_rep_id === session.repId)) {
      currentLeadHint = `\n## 当前 rep 正在 Review 的 lead (context)
id: ${lead.id}
title: ${lead.title}
author: ${lead.author_name ?? "?"}
abstract 前 800 字: ${((lead.abstract as string) ?? "").slice(0, 800)}
`;
    }
  }

  // System prompt is already big (tool catalog + rules). Put the
  // reference corpora in the user message so the LLM treats them as
  // lookup material, not behavior directives.
  const system = SYSTEM_BASE + "\n" + TOOLS_PROMPT;
  let userPrompt = `## Sales Guide (参考资料, 回答 UI 操作问题时用)
${SALES_GUIDE.slice(0, 3500)}

## Qiji Compute Facts (参考资料, 回答话术问题时用)
${QIJI_PROGRAM_FACTS.slice(0, 3500)}
${pathHint}${currentLeadHint}${historyText}
## 用户问题
${question}

记住: 涉及具体数字或具体 lead 时, **必须先** \`\`\`lookup\`\`\`, 不要凭印象答.`;

  // Track the tool calls we ran this turn for UI breadcrumbs.
  const toolTrail: Array<{ tool: string; args: Record<string, unknown>; result: Record<string, unknown> }> = [];
  let finalText = "";
  let model = "";

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const { text, model: mdl } = await callLLM(system, userPrompt);
    model = mdl;
    const toolCalls = extractReadToolCalls(text);

    if (toolCalls.length === 0) {
      finalText = text;
      break;
    }

    // Run each lookup server-side, then re-prompt with results.
    const results = await Promise.all(toolCalls.map((c) => runReadTool(session, c)));
    for (let i = 0; i < toolCalls.length; i++) {
      toolTrail.push({
        tool: toolCalls[i].tool,
        args: toolCalls[i].args,
        result: results[i].result,
      });
    }

    // Build a 2nd-pass prompt feeding the results back.
    const lookupSummary = results.map((r, i) => {
      const call = toolCalls[i];
      // Clamp result payload to avoid runaway context.
      const trimmed = JSON.stringify(r.result).slice(0, 4000);
      return `### ${call.tool}(${JSON.stringify(call.args)}) →\n${trimmed}`;
    }).join("\n\n");

    userPrompt = `${userPrompt}

## 工具查询结果 (round ${iter + 1})
${lookupSummary}

基于上面的真实数据回答用户. 如果需要再查, 继续 lookup; 如果要建议操作, 输出 \`\`\`tool\`\`\` 块; 否则给最终回答.`;

    // Last iteration safety: if we're about to exit and still have
    // lookups, force a final answer.
    if (iter === MAX_ITERATIONS - 1) {
      const { text: final, model: mdl2 } = await callLLM(
        system,
        userPrompt + "\n\n这是最后一轮，必须给最终回答, 不要再调用 lookup.",
      );
      finalText = stripReadToolCalls(final);
      model = mdl2;
      break;
    }
  }

  if (!finalText) finalText = "(no answer)";
  // In case the model leaked a lookup into the final answer, strip it.
  finalText = stripReadToolCalls(finalText);

  const { cleaned, proposal, proposalError } = extractToolProposal(finalText);
  // If the model tried to propose an action with a bad lead_id, append
  // a hint to the answer so the user sees what went wrong and can rephrase.
  const finalAnswer = proposalError
    ? `${cleaned}\n\n⚠️ 我本来想执行一个操作, 但参数有问题 (${proposalError}). 请明确告诉我要操作哪条 lead (说名字或 paper title 就行, 我会先查).`
    : cleaned;

  // Persist.
  if (conversationId) {
    await supabase.from("helper_messages").insert([
      { conversation_id: conversationId, role: "user", text: question },
      { conversation_id: conversationId, role: "assistant", text: finalAnswer, tool_proposal: proposal },
    ]);
    await supabase
      .from("helper_conversations")
      .update({
        updated_at: new Date().toISOString(),
        ...(history.length === 0 ? { title: question.slice(0, 120) } : {}),
      })
      .eq("id", conversationId);
  }

  return NextResponse.json({
    answer: finalAnswer,
    proposal,
    model,
    toolTrail: toolTrail.map((t) => ({
      tool: t.tool,
      args: t.args,
      summary: summarizeToolResult(t.tool, t.result),
    })),
  });
}

function summarizeToolResult(tool: string, result: Record<string, unknown>): string {
  if (result.error) return `error: ${String(result.error).slice(0, 80)}`;
  if (tool === "list_leads" && Array.isArray(result.leads)) {
    return `${result.leads.length} leads`;
  }
  if (tool === "get_lead") return "lead details";
  if (tool === "get_my_stats") return "stats";
  if (tool === "get_rep_info") return "rep info";
  return "ok";
}
