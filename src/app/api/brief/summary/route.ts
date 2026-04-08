import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";

/**
 * GET /api/brief/summary?id=xxx
 *
 * Generates a human-readable sales brief.
 * Accepts either a pipeline_leads id or an arxiv_id (for paper-only matches).
 */
export async function GET(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  // Try pipeline_leads first, then papers table
  let info: Record<string, unknown> | null = null;

  const { data: lead } = await supabase
    .from("pipeline_leads")
    .select("*")
    .eq("id", id)
    .single();

  if (lead) {
    info = lead;
  } else {
    // Might be an arxiv_id from paper_authors search
    const { data: paper } = await supabase
      .from("papers")
      .select("*")
      .eq("arxiv_id", id)
      .single();
    if (paper) {
      info = paper;
    }
  }

  if (!info) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ summary: buildFallbackSummary(info) });
  }

  const prompt = `你是一个帮助销售准备会话的助手。根据以下信息，写一个简短的中文 brief（3-5 句话），帮助销售在微信上和这位研究者聊天时快速了解背景。

要求：
- 用口语化的中文，像是在给同事口头介绍一样
- 第一句话说这个人是谁、在哪里、做什么方向
- 第二句话说他的论文在做什么（用大白话解释，不要用术语堆砌）
- 第三句话说他为什么需要算力（具体说需要什么级别的算力、用来做什么）
- 如果有学校信息，提一下
- 最后一句给一个聊天建议（可以聊什么切入点）

信息：
- 作者: ${info.author_name || info.authors || "未知"}
- 学校: ${info.school_name || "未知"}
- 论文标题: ${info.title}
- 摘要: ${((info.abstract as string) || "").slice(0, 800)}
- 算力需求: ${info.compute_level || "未知"}（置信度 ${info.compute_confidence || "未知"}）
- 算力原因: ${info.compute_reason || "未知"}
- 研究方向: ${info.matched_directions || "未知"}
${info.status ? `- 邮件状态: ${info.status}${info.sent_at ? `，已于 ${info.sent_at} 发送` : ""}` : ""}

只返回 brief 文字，不要加标题或格式符号。`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!res.ok) {
      return NextResponse.json({ summary: buildFallbackSummary(info) });
    }

    const data = await res.json();
    const text: string =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    return NextResponse.json({
      summary: text.trim() || buildFallbackSummary(info),
    });
  } catch {
    return NextResponse.json({ summary: buildFallbackSummary(info) });
  }
}

function buildFallbackSummary(info: Record<string, unknown>): string {
  const parts: string[] = [];

  const name = info.author_name || info.authors || "该研究者";
  const school = info.school_name ? `，来自${info.school_name}` : "";
  parts.push(`${name}${school}。`);

  if (info.title) {
    parts.push(`论文：${info.title}。`);
  }

  if (info.compute_reason) {
    parts.push(`算力需求（${info.compute_level}）：${info.compute_reason}。`);
  }

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
