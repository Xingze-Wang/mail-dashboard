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

const SYSTEM_BASE = `你是 Qiji Pipeline 的销售助手 (Sales Copilot)。

你的工作分三类:
1. **怎么用 app** — 用户问"X 在哪里"/"怎么 Y" → 看 Sales Guide 回答, 给具体路径.
2. **对方问什么怎么答** — 用户问"对方问 X 我怎么回" → 看 Qiji Compute facts, 给可以照着说的中文话术.
3. **执行操作** — 用户说"发 N 个 lead"/"skip 那条"/"重写草稿" → 用工具 (见下).

## 回答风格
- 中文, 口语化, 短.
- 直接给答案 + 1-2 句铺垫.
- 不要 markdown 标题.
- 引用 UI 元素用粗体 (**Pipeline** **Review** **Send**).

## 绝对原则
- 这是「奇绩算力 (Compute)」program. **严禁**回答「奇绩创业营 (Accelerator)」相关问题.
- 不要瞎编数字. 不确定就说"这个我也不太确定, 找 Xingze 确认".
`;

function extractToolProposal(text: string): { cleaned: string; proposal: ToolProposal | null } {
  const m = text.match(/```tool\s*\n([\s\S]*?)\n```/);
  if (!m) return { cleaned: text, proposal: null };
  let proposal: ToolProposal | null = null;
  try {
    const parsed = JSON.parse(m[1].trim());
    if (parsed && typeof parsed === "object" && typeof parsed.action === "string") {
      if (!ACTION_TOOL_NAMES.has(parsed.action)) {
        // Unknown action — drop it.
        return { cleaned: text.replace(/```tool\s*\n[\s\S]*?\n```/, "").trim(), proposal: null };
      }
      if (parsed.action === "batch_send" && typeof parsed.limit === "number") {
        parsed.limit = Math.max(1, Math.min(50, Math.floor(parsed.limit)));
      }
      if (parsed.action === "bulk_flag" && Array.isArray(parsed.lead_ids)) {
        parsed.lead_ids = parsed.lead_ids.slice(0, 20);
      }
      proposal = parsed;
    }
  } catch { /* bad JSON */ }
  const cleaned = text.replace(/```tool\s*\n[\s\S]*?\n```/, "").trim();
  return { cleaned, proposal };
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

  const system = SYSTEM_BASE + "\n" + TOOLS_PROMPT;
  let userPrompt = `## Sales Guide
${SALES_GUIDE.slice(0, 4000)}

## Qiji Compute Facts
${QIJI_PROGRAM_FACTS.slice(0, 4000)}
${pathHint}${historyText}
## 用户问题
${question}

请回答 (必要时调用工具).`;

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

  const { cleaned, proposal } = extractToolProposal(finalText);

  // Persist.
  if (conversationId) {
    await supabase.from("helper_messages").insert([
      { conversation_id: conversationId, role: "user", text: question },
      { conversation_id: conversationId, role: "assistant", text: cleaned, tool_proposal: proposal },
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
    answer: cleaned,
    proposal,
    model,
    toolTrail: toolTrail.map((t) => ({
      tool: t.tool,
      args: t.args,
      // Don't ship the full result to the client — just a short summary
      // ("listed 5 leads", "got stats") to render as a breadcrumb.
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
