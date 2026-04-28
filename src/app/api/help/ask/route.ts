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
import { loadPatterns, type Pattern } from "@/lib/patterns";
import { loadActiveLearnings, formatLearningsForPrompt } from "@/lib/helper-learnings";
import { extractEvidence, EVIDENCE_PROMPT_EXAMPLES, type HelperEvidence } from "@/lib/helper-evidence";

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
- **任何数字声明都要附 evidence 块** (见下方"证据系统"). 没数据就说没数据, 别拍脑袋. 引用方式: 在文字里写 [E1] [E2], 末尾附对应 evidence fence.
- **要敢于反驳 rep**. 当上面"数据驱动的模式"或"累积经验"和 rep 的说法相左, 直接说出来, 附 evidence. 不绕弯子. (但要基于真实数据, 不要为了反驳而反驳.)

## 语言
- 默认中文.
- 如果用户说 "英文回答" / "switch to english" / 用英文提问 → 之后都用英文回答, 直到用户改回来.
- 如果用户说 "帮我翻译 X" / "用英文说这段" → 直接翻译, 不用工具, 不要啰嗦.
- 换语言不需要用户点按钮, 直接说就行.

## 老师傅模式 (帮 rep 成长, 不当 manager)

你不是 sales manager, 是 rep 的搭档. 但你有他们看不到的视角 — 你能看到所有人的数据, 你记得他们之前试过什么. 这视角要用来帮他们慢慢变成 "老师傅", 不是给他们打分.

**Session 开场 (任何对话的第一轮)**:
1. 第一时间 \`\`\`lookup get_my_memory\`\`\` 看上次记下了什么. 如果有相关条目, 自然地接住 ("上次你说想试更短的开头, 这周改了 X 封, 其中 Y 封被回了 — 要看一下吗?"). 不要复述全部 memory, 挑相关的.
2. 如果用户 role=admin, 还要 \`\`\`lookup get_admin_alerts\`\`\` **和** \`\`\`lookup get_integrity_report\`\`\`, 把 admin_alerts 的 high/warn 级 + integrity report 的 red 项合并成 1-3 条以 "今天值得看一眼:" 开场. integrity 的 red 优先 (那是数据系统坏了, 比 alert 更紧). 没东西就别硬编. yellow 不主动提.
3. 如果用户 role=sales (不是 admin), 还要 \`\`\`lookup get_wechat_followups\`\`\`. 如果有 ≥3 天没回的 wechat 加好友, 挑最久的 1-2 个, 用 "你 X 天前在微信加了 Y, 还没收到他的回复 — 要不要 chime back 一下?" 这种方式提一句. 不要列全部, 不要每次都重复同一个 (用户没行动也别天天提).
4. **如果今天是周一 (Beijing time)**, role=sales 时再额外 \`\`\`lookup get_my_weekly_recap\`\`\`. 拿到上周数字后, 用一句自然语言开场, 例如 "上周你 send 了 X 封, 其中 Y 封被 click, Z 个加了微信. 转化的 \\"<title>\\" 那封跟之前发的有什么不同? 我们看一下." — **不要**列表式罗列 4 个数字, 选 1 个有意思的点切入. 如果上周 0 sent, 别尬聊, 跳过这一步.

**当 rep 问 "我做得怎么样" / "我下一步该练什么" / "怎么提高"**:
- \`\`\`lookup get_my_growth\`\`\` 拿到 4 个维度的 rung + 证据.
- 先讲一条他做得好的 (top_strength), 再讲一条最值得练的 (top_opportunity), 给具体的 next_unlock. 不要列 4 个维度全打分 — 那像绩效面试.
- 如果某个维度 rung=null (数据不够), 不用编, 直接说 "X 维度数据还不够 (需要 ≥5 个样本), 先攒数据".

**当 rep 主动告诉你他的偏好 / 战术 / 反思** ("我喜欢简短开头" / "Tsinghua 的 lead 我都用 citation hook" / "我感觉昨天那封写太硬了"):
- 这是值得长期记的事. 提议 \`\`\`tool {"action": "remember_about_rep", ...}\`\`\` 让用户确认存进 memory.
- **写之前先 lookup get_my_memory**, 同义条目就别重复写了.
- 不要把临时情绪 / 牢骚 当 memory 存. memory 是为了下次更聪明, 不是日记.
- 一句话讲清, 600 字以内.

**反例 (不要这样)**:
- ❌ 每次开场都念一遍 memory ("上次你说... 上上次你说... 还有...")
- ❌ 没问就给 4 维度打分 ("targeting 3, writing 2...") — 没人喜欢被随机考核
- ❌ rep 抱怨 "今天太累了" → 存进 memory. 这不是 memory.
- ❌ admin 一开 panel 就把 5 条 alerts 全甩出来 — 选 1-3 条最重要的
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
      if (parsed.action === "remember_about_rep") {
        const allowed = ["rep_pref", "tactic", "self_critique", "other"];
        if (typeof parsed.kind !== "string" || !allowed.includes(parsed.kind)) {
          proposalError = `remember_about_rep: kind must be one of ${allowed.join("|")}`;
        } else if (typeof parsed.body !== "string" || parsed.body.trim().length < 3) {
          proposalError = "remember_about_rep: body must be a non-empty string";
        } else if (parsed.body.length > 600) {
          proposalError = "remember_about_rep: body too long (>600 chars)";
        }
      }
      if (parsed.action === "track_prediction") {
        const allowed = ["no_reply", "no_wechat", "reply", "wechat"];
        if (typeof parsed.claim !== "string" || parsed.claim.trim().length < 5) {
          proposalError = "track_prediction: claim must be ≥5 chars";
        } else if (parsed.claim.length > 500) {
          proposalError = "track_prediction: claim too long (>500 chars)";
        } else if (typeof parsed.targetEvent !== "string" || !allowed.includes(parsed.targetEvent)) {
          proposalError = `track_prediction: targetEvent must be one of ${allowed.join("|")}`;
        }
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

  // Pull current data-driven patterns: rep-specific first (most
  // relevant), then org-wide fallback. These are mined from
  // pipeline_leads + brief_lookups (see lib/patterns.ts) — concrete
  // findings like "in 'location' = CN, wechat rate is 8.2% (2.1× baseline)".
  // The helper uses them when the rep asks tactical questions ("我应该
  // focus 哪类 lead", "为什么 .edu 难转化"). Stays a passive context
  // source — we don't volunteer them unless asked.
  let patternsHint = "";
  try {
    const [repPatterns, orgPatterns] = await Promise.all([
      loadPatterns(session.repId),
      loadPatterns(null),
    ]);
    const top = (arr: Pattern[], n: number) => arr.slice(0, n).map((p) => `- ${p.summary}`).join("\n");
    const sections: string[] = [];
    if (repPatterns.length > 0) {
      sections.push(`### 你 (${session.repName ?? `rep ${session.repId}`}) 当前的数据信号\n${top(repPatterns, 6)}`);
    }
    if (orgPatterns.length > 0) {
      sections.push(`### 全团队当前的数据信号\n${top(orgPatterns, 6)}`);
    }
    if (sections.length > 0) {
      patternsHint = `\n## 数据驱动的模式 (参考资料, 回答策略性问题时用)\n${sections.join("\n\n")}\n`;
    }
  } catch {
    // Patterns table missing or DB blip — degrade silently. The helper
    // still works, just without the data-driven context layer.
  }

  // Load qualitative learnings — distinct from `patterns` (measured).
  // These are things the helper itself decided to remember across
  // sessions: rep preferences, tactical wins, self-critiques. Loaded
  // every turn so the helper doesn't ask the same thing twice and can
  // build on prior conversations.
  let learningsHint = "";
  try {
    const learnings = await loadActiveLearnings(session.repId, 20);
    learningsHint = formatLearningsForPrompt(learnings);
  } catch {
    // Table missing → silent skip.
  }

  // System prompt is already big (tool catalog + rules). Put the
  // reference corpora in the user message so the LLM treats them as
  // lookup material, not behavior directives.
  const system = SYSTEM_BASE + "\n" + TOOLS_PROMPT + "\n" + EVIDENCE_PROMPT_EXAMPLES;
  let userPrompt = `## Sales Guide (参考资料, 回答 UI 操作问题时用)
${SALES_GUIDE.slice(0, 3500)}

## Qiji Compute Facts (参考资料, 回答话术问题时用)
${QIJI_PROGRAM_FACTS.slice(0, 3500)}
${patternsHint}${learningsHint}${pathHint}${currentLeadHint}${historyText}
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

  // Pull evidence blocks BEFORE tool-proposal extraction. Both are
  // independent fenced blocks; order doesn't matter, but doing evidence
  // first keeps the cleaned text unambiguous when a response has both.
  const { cleaned: textNoEvidence, evidence } = extractEvidence(finalText);

  const { cleaned, proposal, proposalError } = extractToolProposal(textNoEvidence);
  // If the model tried to propose an action with a bad lead_id, append
  // a hint to the answer so the user sees what went wrong and can rephrase.
  const finalAnswer = proposalError
    ? `${cleaned}\n\n⚠️ 我本来想执行一个操作, 但参数有问题 (${proposalError}). 请明确告诉我要操作哪条 lead (说名字或 paper title 就行, 我会先查).`
    : cleaned;

  // Persist. Evidence is stored as part of the assistant message so the
  // chat history can re-render expandable cards on a page reload.
  // helper_messages.evidence is added by migration 024. If the column
  // doesn't exist yet (pre-migration), the insert fails the whole
  // transaction and we lose the chat record. Try with evidence; on
  // schema-mismatch error, retry without it so the message still lands.
  if (conversationId) {
    const userMsg = { conversation_id: conversationId, role: "user", text: question };
    const assistantMsg: Record<string, unknown> = {
      conversation_id: conversationId,
      role: "assistant",
      text: finalAnswer,
      tool_proposal: proposal,
      evidence: evidence.length > 0 ? evidence : null,
    };
    let { error: insertError } = await supabase.from("helper_messages").insert([userMsg, assistantMsg]);
    if (insertError && /evidence/i.test(insertError.message)) {
      // Migration 024 hasn't run — drop the field and retry.
      delete assistantMsg.evidence;
      const retry = await supabase.from("helper_messages").insert([userMsg, assistantMsg]);
      insertError = retry.error;
    }
    if (insertError) {
      console.warn("helper_messages insert failed after retry:", insertError.message);
    }
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
    evidence,
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
