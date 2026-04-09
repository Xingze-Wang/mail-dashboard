import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";

/**
 * GET /api/brief/summary?id=xxx
 *
 * Returns: { summary: string, talkingPoints: string[] }
 * - summary: 口语化中文 brief for sales
 * - talkingPoints: 3-4 deep, paper-specific questions to ask on WeChat
 */
export async function GET(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

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

  if (!info) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return NextResponse.json({
      summary: buildFallbackSummary(info),
      talkingPoints: [],
    });
  }

  const prompt = `你是一个帮助销售准备微信会话的助手。根据以下论文信息，返回一个JSON对象，包含两部分。

信息：
- 作者: ${info.author_name || info.authors || "未知"}
- 学校: ${info.school_name || "未知"}
- 论文标题: ${info.title}
- 摘要: ${((info.abstract as string) || "").slice(0, 1200)}
- 算力需求: ${info.compute_level || "未知"}（置信度 ${info.compute_confidence || "未知"}）
- 算力原因: ${info.compute_reason || "未知"}
- 研究方向: ${info.matched_directions || "未知"}
${info.status ? `- 邮件状态: ${info.status}${info.sent_at ? `，已于 ${info.sent_at} 发送` : ""}` : ""}

请返回以下JSON格式：
{
  "summary": "3-5句口语化中文brief，像给同事口头介绍。第一句说人+学校+方向。第二句大白话解释论文做了什么。第三句说为什么需要算力。最后一句给微信聊天切入点。",
  "talking_points": [
    "基于论文内容的深度问题1 — 要具体到论文的方法/发现，不要泛泛而谈。比如：你们在XX实验中用了YY方法，如果scale up到ZZ规模，预计需要什么级别的算力？",
    "基于论文内容的深度问题2 — 可以问他们下一步计划、瓶颈在哪、如果有更多算力想先做什么",
    "基于论文内容的深度问题3 — 展示你读过他的论文，问一个只有读过才能问的问题",
    "关于合作的自然过渡 — 如何从技术讨论自然引到算力支持申请"
  ]
}

要求：
- talking_points 必须是具体的、基于这篇论文的问题，不是通用问题
- 每个问题都应该展示出你理解了这篇论文的核心贡献
- 用中文写，语气像同事间的技术讨论
- 只返回JSON，不要其他文字`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
        }),
        signal: AbortSignal.timeout(20_000),
      },
    );

    if (!res.ok) {
      return NextResponse.json({
        summary: buildFallbackSummary(info),
        talkingPoints: [],
      });
    }

    const data = await res.json();
    const raw: string =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    // Parse JSON from response
    const cleaned = raw
      .trim()
      .replace(/^```\w*\n?/g, "")
      .replace(/```$/g, "")
      .trim();

    try {
      const parsed = JSON.parse(cleaned);
      return NextResponse.json({
        summary: parsed.summary || buildFallbackSummary(info),
        talkingPoints: parsed.talking_points || [],
      });
    } catch {
      // If JSON parse fails, treat entire response as summary
      return NextResponse.json({
        summary: raw.trim() || buildFallbackSummary(info),
        talkingPoints: [],
      });
    }
  } catch {
    return NextResponse.json({
      summary: buildFallbackSummary(info),
      talkingPoints: [],
    });
  }
}

function buildFallbackSummary(info: Record<string, unknown>): string {
  const parts: string[] = [];
  const name = info.author_name || info.authors || "该研究者";
  const school = info.school_name ? `，来自${info.school_name}` : "";
  parts.push(`${name}${school}。`);
  if (info.title) parts.push(`论文：${info.title}。`);
  if (info.compute_reason) parts.push(`算力需求（${info.compute_level}）：${info.compute_reason}。`);
  if (info.matched_directions) {
    let dirs: string;
    try {
      const parsed = JSON.parse(info.matched_directions as string);
      dirs = Array.isArray(parsed) ? parsed.join("、") : String(info.matched_directions);
    } catch {
      dirs = String(info.matched_directions);
    }
    parts.push(`研究方向：${dirs}。`);
  }
  return parts.join("");
}
