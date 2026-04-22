import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { llmChat } from "@/lib/llm-proxy";
import { requireSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/help/paper
 * Body: { leadId: string, question: string, history?: {role, text}[] }
 *
 * Paper-comprehension tutor for the Review pane. Strictly READ-ONLY:
 * explains what the paper is about, what's novel, why compute matters —
 * but NEVER suggests what sales should write in emails. That's on purpose:
 * /api/brief/ask and /api/help/ask already do script-writing; this one is
 * a research tutor so sales builds their own mental model of the paper
 * before reaching out.
 *
 * Grounded only in the lead's paper fields (title, abstract, authors,
 * published_at, matched_directions, compute_reason). No Qiji facts
 * corpus — keeping the prompt narrow is what prevents drift into
 * "here's what to say."
 */

const SYSTEM = `你是一位帮销售理解 AI 论文的研究助手 (Research Tutor)。

销售不是技术背景的人，他们要联系这位论文作者，但需要先弄懂这篇论文在做什么。你的工作是帮他们读懂 paper。

回答原则：
- 用中文，口语化，但技术词保留英文（如 "embedding" "transformer" "diffusion"）
- 把复杂概念翻译成大白话，用类比 (analogy) 帮助理解
- 回答具体、聚焦问题，不要泛泛而谈
- 不要 markdown 标题，纯文字
- 不知道就说"abstract 里没说，可能要看 full paper"

绝对不要做的事（非常重要）：
- 🚫 不要建议销售「你应该这样说」「你可以这么回」「话术是...」
- 🚫 不要提奇绩、算力、申请、GPU、邮件、outreach
- 🚫 不要给 email 模板、微信话术、任何销售脚本
- 🚫 不要说"用这个角度切入"这种销售指导语

如果用户问了销售相关的问题（怎么发邮件、怎么回复对方），回答：
"这个问题销售助手（左下角 💬）更合适，我这里只负责帮你读懂论文。"

你只做一件事：把这篇 paper 讲清楚。`;

export async function POST(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const leadId = String(body.leadId ?? "").trim();
  const question = String(body.question ?? "").trim();
  const history = Array.isArray(body.history) ? body.history.slice(-4) : [];

  if (!leadId) return NextResponse.json({ error: "leadId required" }, { status: 400 });
  if (!question) return NextResponse.json({ error: "question required" }, { status: 400 });
  if (question.length > 500) return NextResponse.json({ error: "question too long (max 500 chars)" }, { status: 400 });

  const { data: lead, error } = await supabase
    .from("pipeline_leads")
    .select("title, abstract, authors, published_at, matched_directions, compute_level, compute_reason, school_name")
    .eq("id", leadId)
    .maybeSingle();

  if (error || !lead) {
    return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  }

  // Clip abstract to protect the context window but give the tutor enough
  // substance to reason about. 3000 chars ≈ most full abstracts + a bit
  // of headroom for non-English papers where char != token.
  const abstract = (lead.abstract as string | null) ?? "(no abstract on file)";
  const paperContext = `## 这篇论文
标题: ${lead.title}
作者: ${lead.authors ?? "未知"}
发表时间: ${lead.published_at ?? "未知"}
学校: ${lead.school_name ?? "未知"}
方向分类 (我们系统打的标签): ${lead.matched_directions ?? "未知"}
算力档位 (我们系统估计): ${lead.compute_level ?? "未知"}${lead.compute_reason ? ` — ${lead.compute_reason}` : ""}

## 摘要 (Abstract)
${abstract.slice(0, 3000)}`;

  const historyText = history.length > 0
    ? "\n## 上文对话\n" + history.map((m: { role: string; text: string }) =>
        `${m.role === "user" ? "销售" : "助手"}: ${String(m.text).slice(0, 600)}`
      ).join("\n") + "\n"
    : "";

  const user = `${paperContext}
${historyText}
## 销售的问题
${question}

请解释。`;

  let answer = "";
  let model = "";
  try {
    const r = await llmChat({
      model: "gemini-3-flash",
      system: SYSTEM,
      user,
      temperature: 0.3,
      max_tokens: 900,
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
        temperature: 0.3,
        max_tokens: 900,
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
