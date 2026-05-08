import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";
import { getSchoolInfo } from "@/lib/template-assembler";

export const maxDuration = 60;

/**
 * POST /api/templates/critique
 * Body: { template_id, lead_id, paragraph?: string }
 *
 * The "psychologist" view. Takes a single (template, lead, paragraph)
 * and asks an LLM to qualitatively read it FROM THE RECIPIENT'S
 * PERSPECTIVE: What's the tone? What status signal does it send?
 * Where's the friction? What might a CN academic feel that a US
 * industry researcher wouldn't?
 *
 * If `paragraph` is omitted, critiques all 5 sections together (more
 * holistic but less actionable). When provided, focused critique on
 * that one section — admin can isolate "is school_pitch the problem?"
 *
 * This is NOT statistical — it complements (doesn't replace) reply-rate
 * data. The user explicitly framed this layer: "或许我们需要
 * psychologists？产出一些insights也不错". The critique speaks to
 * mechanisms, the data speaks to outcomes; you need both.
 *
 * Auth: admin only.
 */

async function requireAdmin(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return null;
  const { data: rep } = await supabase
    .from("sales_reps")
    .select("role")
    .eq("id", session.repId)
    .maybeSingle();
  if (!rep || rep.role !== "admin") return null;
  return session;
}

const SECTIONS = [
  "subject_format",
  "intro_prompt",
  "greeting_format",
  "rep_intro_format",
  "school_pitch_format",
  "cta_signoff_format",
] as const;
type Section = typeof SECTIONS[number];

function sectionLabel(s: Section): string {
  return {
    subject_format: "Subject line",
    intro_prompt: "Personalized intro (LLM prompt)",
    greeting_format: "Greeting",
    rep_intro_format: "Rep introduction paragraph",
    school_pitch_format: "School + compute pitch paragraph",
    cta_signoff_format: "CTA + signoff paragraph",
  }[s];
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as {
    template_id?: string;
    lead_id?: number;
    paragraph?: Section;
  };
  if (!body.template_id || !body.lead_id) {
    return NextResponse.json({ error: "template_id + lead_id required" }, { status: 400 });
  }
  if (body.paragraph && !SECTIONS.includes(body.paragraph)) {
    return NextResponse.json({ error: "invalid paragraph" }, { status: 400 });
  }

  const [{ data: template }, { data: lead }] = await Promise.all([
    supabase.from("email_templates").select("*").eq("id", body.template_id).maybeSingle(),
    supabase
      .from("pipeline_leads")
      .select(
        "id, title, abstract, author_email, first_name, school_name, school_tier, matched_directions",
      )
      .eq("id", body.lead_id)
      .maybeSingle(),
  ]);
  if (!template) return NextResponse.json({ error: "template not found" }, { status: 404 });
  if (!lead) return NextResponse.json({ error: "lead not found" }, { status: 404 });

  // Build a recipient profile from what we know about the lead. The
  // critique LLM needs context about WHO is reading this, not just
  // WHAT they're reading.
  const lower = (lead.author_email ?? "").toLowerCase();
  const geo: "cn" | "edu" | "overseas" = lower.endsWith(".cn")
    ? "cn"
    : lower.endsWith(".edu") || lower.endsWith(".edu.cn")
    ? "edu"
    : "overseas";
  const schoolInfo = getSchoolInfo(lead.author_email);
  const profile = [
    `Email: ${lead.author_email}`,
    `Inferred geo: ${geo}`,
    schoolInfo
      ? `School: ${schoolInfo.name} (tier ${schoolInfo.tier})`
      : `School: ${lead.school_name ?? "(unknown)"}`,
    `Paper: "${lead.title}"`,
    `Abstract: ${(lead.abstract ?? "").slice(0, 500)}…`,
    lead.matched_directions?.length
      ? `Inferred research directions: ${lead.matched_directions.slice(0, 5).join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  // Build the section content to critique. For non-prompt sections we
  // pass the format string (with {{placeholders}} inline) — the
  // critique reads format + intent rather than fully-rendered text,
  // because that's what the admin can edit. For intro_prompt we pass
  // the prompt itself, since the critique target IS the prompt.
  const sectionsToReview: Section[] = body.paragraph ? [body.paragraph] : [...SECTIONS];
  const sectionsBlock = sectionsToReview
    .map((s) => `## ${sectionLabel(s)}\n${(template as Record<string, string>)[s] ?? "(empty)"}`)
    .join("\n\n");

  const prompt = `你是一位心理学家 + 跨文化沟通专家. 我会给你一封冷启动销售邮件的模板, 以及收件人的画像. 请站在收件人的角度, 读这些段落.

# 收件人画像
${profile}

# 邮件模板段落 (注意: {{placeholder}} 是占位符, 实际发送时会被替换)
${sectionsBlock}

# 你的任务
对每个段落, 给出 3 条洞察, 每条 1-2 句:
1. **隐含的语气 / status 信号** — 收件人会觉得发件人是"什么身份的人在跟我说话"? 平视? 仰视? 推销?
2. **情感反应 / 摩擦点** — 收件人读到这段, 第一感觉是什么? 哪句话可能让人皱眉? (具体到字句)
3. **针对此画像 (${geo}) 的具体建议** — 这段对这位收件人来说, 哪里需要调整? 加什么 / 删什么 / 换什么措辞?

格式要求: Markdown, 每个段落用 ### 开头, 下面三个小条目. 用中文回答. 直接输出, 不要 preface, 不要总结.`;

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "GOOGLE_API_KEY not set" }, { status: 503 });

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      signal: AbortSignal.timeout(40_000),
    },
  );
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    return NextResponse.json({ error: `Gemini ${res.status}: ${txt.slice(0, 200)}` }, { status: 502 });
  }
  const data = await res.json();
  const critique: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

  return NextResponse.json({
    template_id: body.template_id,
    lead_id: body.lead_id,
    paragraph: body.paragraph ?? "(all)",
    geo,
    school_tier: schoolInfo?.tier ?? lead.school_tier,
    critique,
  });
}
