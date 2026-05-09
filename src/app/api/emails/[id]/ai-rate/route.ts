import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

export const maxDuration = 60;

/**
 * POST /api/emails/[id]/ai-rate
 *
 * Calls Gemini with (resolved prompt, intro output, recipient profile)
 * and asks for a 1-5 score + WHY-reasoning. Stores in email_ratings
 * (rater_kind='ai'). Idempotent — re-running refreshes the row.
 *
 * The "why" requirement is the user's explicit framing: insights need
 * mechanism, not just numbers. Reasoning becomes the discussion seed
 * for /admin/template-insights and congress proposals.
 *
 * Auth: admin only. Sales reps have their own /rate (human-side) flow.
 */

const RATER_PROMPT = `你是一位有经验的销售评估员，正在审阅一封冷启动邮件草稿。

# 你拿到的输入
1. 邮件最个性化的一句话（LLM 生成的"intro"）
2. 这封邮件用的 prompt（产生 intro 的指令）
3. 收件人画像：邮箱域名、学校、研究方向、论文标题/摘要

# 你要做的
打 1-5 分，并给出**为什么**：
- 1 = 这封邮件大概率被秒删；语气/角度对这位收件人完全不对
- 2 = 这封邮件可能被打开但不会激起回复
- 3 = 标准水平，不会减分但也不出彩
- 4 = 这封邮件很可能让收件人停下来读完
- 5 = 这封邮件让收件人觉得"这家公司真的懂我"，会想回信

返回 JSON 严格按这个格式（只返回 JSON，不要 markdown 代码块）:
{
  "score": <int 1-5>,
  "why": "<60-150字。具体说为什么，引用邮件里的具体句子或词。提到收件人画像里的什么东西支持你的判断。>"
}

# 数据`;

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

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const { id } = await params;
  const { data: email } = await supabase
    .from("emails")
    .select(
      "id, to, subject, intro_prompt_resolved, intro_output, paper_arxiv_id, template_id",
    )
    .eq("id", id)
    .maybeSingle();
  if (!email) return NextResponse.json({ error: "Email not found" }, { status: 404 });

  // Need at least intro_output to rate (it's the AI-generated chunk).
  // intro_prompt_resolved nullable on legacy/Python-supplied emails;
  // we still rate, but the rater sees less context.
  if (!email.intro_output) {
    return NextResponse.json(
      { error: "Email has no intro_output (likely a legacy send). Cannot rate." },
      { status: 422 },
    );
  }

  // Pull recipient profile via paper_arxiv_id → pipeline_leads (where
  // school / first_name / matched_directions live).
  let recipientProfile = "";
  if (email.paper_arxiv_id) {
    const { data: lead } = await supabase
      .from("pipeline_leads")
      .select("first_name, school_name, school_tier, matched_directions, title, abstract")
      .eq("arxiv_id", email.paper_arxiv_id)
      .maybeSingle();
    if (lead) {
      const lower = (email.to as string | null)?.toLowerCase() ?? "";
      const geo = lower.endsWith(".cn")
        ? "cn"
        : lower.endsWith(".edu") || lower.endsWith(".edu.cn")
        ? "edu"
        : "overseas";
      recipientProfile = [
        `Email: ${email.to}`,
        `Geo: ${geo}`,
        `School: ${lead.school_name ?? "(unknown)"} (tier ${lead.school_tier ?? "?"})`,
        `First name: ${lead.first_name ?? "(unknown)"}`,
        `Paper: "${lead.title ?? "(unknown)"}"`,
        `Abstract: ${(lead.abstract ?? "").slice(0, 400)}…`,
        Array.isArray(lead.matched_directions) && lead.matched_directions.length > 0
          ? `Directions: ${lead.matched_directions.slice(0, 5).join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
    }
  }

  const fullPrompt = `${RATER_PROMPT}

## 1. The intro sentence (LLM-generated, paragraph 2 of the email)
${email.intro_output}

## 2. The prompt that produced it
${email.intro_prompt_resolved ?? "(legacy send — prompt not captured)"}

## 3. Recipient profile
${recipientProfile || "(no profile available)"}

## 4. Subject line
${email.subject ?? "(no subject)"}`;

  // Route via MiraclePlus proxy (Vercel hkg1 → direct Gemini errors
  // with FAILED_PRECONDITION 'location not supported').
  let raw = "";
  try {
    const { llmChat } = await import("@/lib/llm-proxy");
    const r = await llmChat({
      model: "gemini-2.5-flash",
      user: fullPrompt,
      temperature: 0.3,
      max_tokens: 800,
      timeoutMs: 40_000,
    });
    raw = r.text ?? "";
  } catch (e) {
    return NextResponse.json(
      { error: `AI rater failed: ${(e as Error).message}` },
      { status: 502 },
    );
  }
  // Strip markdown fences if Gemini ignored the "no markdown" instruction.
  const clean = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  let parsed: { score?: unknown; why?: unknown };
  try {
    parsed = JSON.parse(clean);
  } catch {
    return NextResponse.json(
      { error: `Gemini returned non-JSON: ${clean.slice(0, 200)}` },
      { status: 502 },
    );
  }
  const score = typeof parsed.score === "number" ? Math.round(parsed.score) : NaN;
  const why = typeof parsed.why === "string" ? parsed.why : "";
  if (!Number.isFinite(score) || score < 1 || score > 5) {
    return NextResponse.json(
      { error: `Invalid score from rater: ${parsed.score}` },
      { status: 502 },
    );
  }

  const { error: upsertErr } = await supabase
    .from("email_ratings")
    .upsert(
      {
        email_id: id,
        rater_kind: "ai",
        score,
        reasoning: why,
        model_id: "gemini-2.0-flash",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "email_id,rater_kind" },
    );
  if (upsertErr) {
    return NextResponse.json({ error: upsertErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, score, why });
}
