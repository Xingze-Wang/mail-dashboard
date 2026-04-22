import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { llmChat } from "@/lib/llm-proxy";
import { requireSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/brief/summary?id=xxx
 *
 * Returns a structured brief for the sales rep:
 *   {
 *     paper:          "1 sentence naming the paper + authors"
 *     mainIdea:       "2-3 sentences — what the paper does in plain Chinese"
 *     coreInnovation: "2-3 sentences — what's actually new, why it matters"
 *     questions:      ["3 paper-specific technical questions to ask on WeChat"]
 *     approach:       "2-3 sentences — how sales should open the conversation"
 *     summary:        back-compat string = whole thing concatenated, so old
 *                     callers still render something sensible
 *   }
 *
 * Uses Opus via the MiraclePlus proxy, falls back to Gemini 2.0 Flash on
 * Opus failure. Never returns 500 — if both LLMs fail, we ship a minimal
 * rule-based fallback so sales always sees *something*.
 */

interface StructuredBrief {
  paper: string;
  mainIdea: string;
  coreInnovation: string;
  questions: string[];
  approach: string;
  persuasionAngle: "ethos" | "logos" | "pathos";
  angleHint: string;
}

export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  let info: Record<string, unknown> | null = null;

  const { data: lead } = await supabase
    .from("pipeline_leads")
    .select("*")
    .eq("id", id)
    .single();

  if (lead) {
    info = lead;
  } else {
    const { data: paper } = await supabase
      .from("papers")
      .select("*")
      .eq("arxiv_id", id)
      .single();
    if (paper) info = paper;
  }

  if (!info) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const prompt = buildPrompt(info);

  // Opus → Gemini fallback, per the "Opus-only with Gemini fallback" rule.
  let brief: StructuredBrief | null = null;
  try {
    const r = await llmChat({
      model: "claude-opus-4.7",
      system: SYSTEM,
      user: prompt,
      temperature: 0.2,
      max_tokens: 1500,
      json: true,
      timeoutMs: 30_000,
    });
    brief = parseBrief(r.text);
  } catch {
    // fall through
  }

  if (!brief) {
    try {
      const r = await llmChat({
        model: "gemini-3-pro",
        system: SYSTEM,
        user: prompt,
        temperature: 0.2,
        max_tokens: 1500,
        json: true,
        timeoutMs: 30_000,
      });
      brief = parseBrief(r.text);
    } catch {
      // fall through to hardcoded fallback
    }
  }

  if (!brief) brief = fallbackBrief(info);

  // Back-compat: stitch sections into a single `summary` string too, so the
  // existing DetailView (which only renders `summary`) degrades gracefully
  // until its UI is updated.
  const summary = [
    brief.paper,
    "",
    `【主要想法】${brief.mainIdea}`,
    "",
    `【核心创新】${brief.coreInnovation}`,
    "",
    "【可以聊的技术问题】",
    ...brief.questions.map((q, i) => `${i + 1}. ${q}`),
    "",
    `【怎么切入】${brief.approach}`,
  ].join("\n");

  return NextResponse.json({
    ...brief,
    summary,
    // Also return `talkingPoints` for any lingering callers reading the old shape.
    talkingPoints: brief.questions,
  });
}

const SYSTEM = `你是帮销售准备聊微信的论文助手。销售不是技术出身，但聊天的对象是博士/教授。你的 brief 要让销售能 5 秒内抓住论文在做什么，并能问出几个只有"真的读过"才能问的问题。

输出风格：
- 中文，口语化，但技术词该用就用（不要把 "attention" 翻成 "注意力机制" 这种），Agent这种词英文就行
- 不啰嗦，不总结废话
- 问题要具体到论文里真实出现过的方法/实验/设定，不要 "你对 X 方向怎么看" 这种空话`;

function buildPrompt(info: Record<string, unknown>): string {
  const authors = info.author_name || info.authors || "未知";
  const school = info.school_name || "未知";
  const title = info.title ?? "";
  const abstract = ((info.abstract as string) || "").slice(0, 1800);
  const computeLevel = info.compute_level || "未知";
  const computeReason = info.compute_reason || "";
  const directions = info.matched_directions || "";

  return `信息：
- 作者: ${authors}
- 学校: ${school}
- 标题: ${title}
- 摘要: ${abstract}
- 算力档位: ${computeLevel}
- 算力需求理由: ${computeReason}
- 研究方向: ${directions}

请只返回一个 JSON 对象：
{
  "paper": "一句话：作者 (学校) 的 xx 论文 / 《标题》",
  "mainIdea": "2-3 句话，口语地说论文在做一件什么事（问题是什么 + 他们用什么方法去解）",
  "coreInnovation": "2-3 句话，这篇论文哪里新。点出具体的技术 insight —— 是架构改动？训练方法？数据？评测？不要说'提出了新方法'这种空话。",
  "questions": [
    "问题 1：针对论文里具体的某个方法/实验/发现问一个技术问题，让对方一看就知道你读过",
    "问题 2：问他下一步想做什么 / 现在的瓶颈 / 如果 scale up 会遇到什么",
    "问题 3：问一个关于实验局限或 reviewer 可能 push 的点（从实验章节推断）"
  ],
  "approach": "2-3 句话，销售怎么开场。基于问题 1 自然切入，最后过渡到算力合作。不要直接说'我们有算力'，要先让对方觉得你懂他研究。",
  "persuasionAngle": "ethos | logos | pathos —— 选最适合打动这个研究者的角度。判断标准：
    - ethos（权威/背书）：资深 PI、知名实验室、有 industry 经验的人。强调奇绩 portfolio、谁在用我们。
    - logos（理性/数据）：industry researcher、追求 ROI 的人、reviewer 风格的论文。强调具体数字（100万额度、1.5%通过率、免费、不占股）。
    - pathos（共情/赋能）：年轻 PhD、做创新性强但资源紧的工作、第一作者新人。强调'你的工作很重要，我们想 enable'。",
  "angleHint": "一句话告诉销售用什么策略和这个人聊。例：'资深 PI，重点提奇绩支持过的同领域 portfolio'，或'年轻 PhD，先认可 idea 的独特性再谈算力'。≤30 字。"
}

只返回 JSON，不要任何其它文字。不要 markdown 包裹。`;
}

function parseBrief(raw: string): StructuredBrief | null {
  const cleaned = raw
    .trim()
    .replace(/^```\w*\n?/g, "")
    .replace(/```$/g, "")
    .trim();
  try {
    const obj = JSON.parse(cleaned);
    const questions = Array.isArray(obj.questions)
      ? (obj.questions as unknown[]).map(String).filter((q) => q.trim()).slice(0, 5)
      : [];
    if (!obj.paper || !obj.mainIdea || !obj.coreInnovation || questions.length === 0 || !obj.approach) {
      return null;
    }
    // Persuasion fields are optional — fall back to logos + neutral hint
    // so old prompts and missing fields don't break the response.
    const angleRaw = String(obj.persuasionAngle ?? obj.persuasion_angle ?? "logos").toLowerCase();
    const persuasionAngle: StructuredBrief["persuasionAngle"] =
      angleRaw === "ethos" || angleRaw === "pathos" ? angleRaw : "logos";
    return {
      paper: String(obj.paper),
      mainIdea: String(obj.mainIdea),
      coreInnovation: String(obj.coreInnovation),
      questions,
      approach: String(obj.approach),
      persuasionAngle,
      angleHint: String(obj.angleHint ?? obj.angle_hint ?? "").slice(0, 120),
    };
  } catch {
    return null;
  }
}

function fallbackBrief(info: Record<string, unknown>): StructuredBrief {
  const author = (info.author_name || info.authors || "该研究者") as string;
  const school = (info.school_name as string) || "";
  const title = (info.title as string) || "(未命名论文)";
  const reason = (info.compute_reason as string) || "";
  const directions = (info.matched_directions as string) || "";
  return {
    paper: `${author}${school ? `（${school}）` : ""}的论文《${title}》`,
    mainIdea: (info.abstract as string)?.slice(0, 200) || "摘要暂不可用。",
    coreInnovation: reason || "摘要里没明显指出创新点，建议直接读原文。",
    questions: [
      "论文里的核心方法在更大模型/更大数据上是否稳定？",
      "下一步想做什么？现在最卡的是算力、数据还是别的？",
      directions ? `在 ${directions} 方向上，这篇 insight 是否能迁移到相关任务？` : "这个方法在相关任务上迁移得如何？",
    ],
    approach: "先针对论文里某个具体发现问一个问题，让对方知道你读过，再引到「如果有更多算力你会做什么」，自然过渡到算力申请。",
    persuasionAngle: "logos",
    angleHint: "默认走 logos：先讲数字（100万、免费、不占股），再过渡到算力支持。",
  };
}
