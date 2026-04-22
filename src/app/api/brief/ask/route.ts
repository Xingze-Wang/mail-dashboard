import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { llmChat } from "@/lib/llm-proxy";
import { QIJI_PROGRAM_FACTS } from "@/lib/qiji-facts";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/brief/ask
 * Body: { leadId: string, question: string }
 *
 * Sales asks "how do I answer X about this lead/program?" and gets a Chinese
 * response grounded in (a) the lead's paper context, (b) the 奇绩 facts
 * corpus. Uses gemini-3-flash for ~3s latency. No streaming yet — sales
 * tolerates one round-trip; complexity of streaming isn't worth it here.
 */

const SYSTEM = `你是销售助手 (Sales Copilot)。
销售正在和一位 AI 论文作者聊微信。他们问你一个问题，你需要：
1. 用上「论文上下文」准确知道作者背景（不要泛泛而谈）
2. 用上「奇绩 program facts」给出准确的项目信息（不要瞎编额度、流程、政策）
3. 回答要简短、口语化、给销售可以直接照着说的中文话术
4. 如果问题超出 facts 范围，老实说"这个我们 mentor team 跟进"，不要编造

输出风格：
- 中文为主，技术词保留英文
- 直接给答案 + 1-2 句铺垫，不要长篇大论
- 如果有几种回答方式，用 1./2./3. 列出来
- 不要 markdown 标题，纯文字`;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const leadId = String(body.leadId ?? "").trim();
  const question = String(body.question ?? "").trim();

  if (!question) return NextResponse.json({ error: "question required" }, { status: 400 });
  if (question.length > 500) return NextResponse.json({ error: "question too long (max 500 chars)" }, { status: 400 });

  // Pull lead context if leadId provided. Optional — sales might ask a
  // generic question (e.g. "what's our equity policy"); we still answer
  // using just the program facts.
  let leadContext = "";
  if (leadId) {
    const { data: lead } = await supabase
      .from("pipeline_leads")
      .select("title, abstract, author_name, school_name, school_tier, compute_level, compute_reason, matched_directions, citation_count, h_index")
      .eq("id", leadId)
      .maybeSingle();
    if (lead) {
      leadContext = `## 论文上下文 (这位研究者的背景)
- 作者: ${lead.author_name ?? "未知"}
- 学校: ${lead.school_name ?? "未知"} (tier ${lead.school_tier ?? "未知"})
- 论文: ${lead.title}
- 摘要: ${(lead.abstract as string ?? "").slice(0, 1200)}
- 算力档位: ${lead.compute_level ?? "未知"}
- 算力理由: ${lead.compute_reason ?? "未知"}
- 方向: ${lead.matched_directions ?? "未知"}
- 引用数: ${lead.citation_count ?? "未知"} | h-index: ${lead.h_index ?? "未知"}
`;
    }
  }

  const user = `${leadContext ? leadContext + "\n" : ""}## 奇绩 program facts (你的事实库)
${QIJI_PROGRAM_FACTS}

## 销售的问题
${question}

请回答。`;

  // Flash for speed; Pro fallback if Flash blips.
  let answer = "";
  let model = "";
  try {
    const r = await llmChat({
      model: "gemini-3-flash",
      system: SYSTEM,
      user,
      temperature: 0.4,
      max_tokens: 800,
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
        max_tokens: 800,
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

  return NextResponse.json({ answer, model });
}
