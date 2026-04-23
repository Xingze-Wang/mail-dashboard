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

## 语气规则 (硬规则, 不要违反)
- 中文为主, 技术词保留英文 (override, ready, queue, lead, batch, Pipeline, Review).
- 短句. 一行一句. 能一句话说完不说两句.
- 事实第一, 情绪第二 (如果有).
- **不用** emoji.
- **不用** 语气词 ("哈" "呀" "呢" "哦" "嘿" "诶" "啦").
- **不用** 敬称 ("您" "请问").
- 给决策就明确 ("要不要 / 要吗"), 不要 "建议" "不妨" "可以考虑".
- 没话说就不说. 别硬聊.

## 工作范围
1. app 操作问题 ("X 在哪") → 看 Sales Guide 答.
2. 话术问题 ("对方问 X 怎么回") → 看 Qiji Compute facts 答.
3. 执行 ("发 N 个" / "skip 这条") → 用工具 (见下).

## 绝对原则
- 这是「奇绩算力」program. 严禁回答「奇绩创业营」相关 (投资额 / 股权 / batch 时间).
- 不瞎编数字. 不确定就说 "不确定, 找 Xingze".
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
      if ((parsed.action === "skip_lead" || parsed.action === "flag_lead" || parsed.action === "redraft_lead")) {
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

  // System prompt is already big (tool catalog + rules). Put the
  // reference corpora in the user message so the LLM treats them as
  // lookup material, not behavior directives.
  const system = SYSTEM_BASE + "\n" + TOOLS_PROMPT;
  let userPrompt = `## Sales Guide (参考资料, 回答 UI 操作问题时用)
${SALES_GUIDE.slice(0, 3500)}

## Qiji Compute Facts (参考资料, 回答话术问题时用)
${QIJI_PROGRAM_FACTS.slice(0, 3500)}
${pathHint}${historyText}
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
