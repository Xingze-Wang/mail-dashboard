/**
 * Template-driven email assembly.
 *
 * Replaces email-generator.ts's hardcoded assembly with a
 * template-driven one. A template is a row in `email_templates` that
 * spells out the subject line + four body paragraphs as format strings
 * with {{placeholder}} tokens. This lib:
 *
 *   1. Loads the right template for a rep (per-rep if one exists and
 *      is active, else the "global" template).
 *   2. Calls the LLM with template.intro_prompt to produce the
 *      personalized intro sentence (paragraph 2).
 *   3. Computes the school/compute pitch phrases (paragraph 3) from
 *      SCHOOL_DATA + matchedDirections — SAME rules as the old
 *      generateThirdParagraph(), now feeding into school_pitch_format
 *      instead of building the HTML inline.
 *   4. Substitutes placeholders and returns {subject, html}.
 *
 * Design notes:
 *   - If no template exists for "global" in the DB, we fall back to
 *     calling the old generateDraft() from email-generator.ts. This
 *     keeps the system running even if migration 011 wasn't applied.
 *   - Per-rep templates are preferred over global. When a per-rep
 *     template is active, EVERY placeholder in every part comes from
 *     that template, not from global — i.e. the rep can diverge from
 *     global on any part of the email, not just the intro.
 *   - HTML safety: all dynamic string substitutions are HTML-escaped
 *     EXCEPT (a) placeholders that hold pre-computed HTML (none
 *     currently), and (b) the `<a>` tag in cta_signoff_format, which
 *     is part of the template itself (template author's responsibility
 *     to keep it valid).
 */

import { SCHOOL_DATA, APPLY_URL_CTA, WECHAT_ARTICLE_URL, type SchoolInfo } from "./scanner-config";
import { supabase } from "./db";

export interface EmailTemplate {
  id: string;
  name: string;
  rep_id: number | null;
  active: boolean;
  subject_format: string;
  intro_prompt: string;
  greeting_format: string;
  rep_intro_format: string;
  school_pitch_format: string;
  cta_signoff_format: string;
}

export interface AssemblyInput {
  title: string;
  abstract: string;
  authorEmail: string;
  firstName: string | null;
  schoolName: string | null;
  schoolTier: number | null;
  matchedDirections: string[];
  repName: string;
  repWechatId: string;
}

// ── HTML escape ──────────────────────────────────────────────────────
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// ── School info (unchanged from email-generator.ts) ──────────────────
export function getSchoolInfo(email: string): SchoolInfo | null {
  const domain = email.split("@").pop()?.toLowerCase() ?? "";
  if (SCHOOL_DATA[domain]) return SCHOOL_DATA[domain];
  const parts = domain.split(".");
  for (let i = 0; i < parts.length; i++) {
    const partial = parts.slice(i).join(".");
    if (SCHOOL_DATA[partial]) return SCHOOL_DATA[partial];
  }
  return null;
}

// ── Subject truncation ───────────────────────────────────────────────
function truncateSubject(subject: string, maxLen = 200): string {
  if (subject.length <= maxLen) return subject;
  const trimmed = subject.slice(0, maxLen - 3);
  const lastSpace = trimmed.lastIndexOf(" ");
  return (lastSpace > 0 ? trimmed.slice(0, lastSpace) : trimmed) + "...";
}

// ── School pitch phrase computation ──────────────────────────────────
// Returns the substitution values that the template's
// school_pitch_format will use. NOT HTML — escaped at substitution
// time.
function computeSchoolPitchVars(
  schoolInfo: SchoolInfo | null,
  matchedDirections: string[],
): { school_text: string; base_info: string; directions_text: string } {
  const base_info = "单项目最高支持100万等值算力，相当于8卡H100连续跑15个月";

  let school_text: string;
  if (schoolInfo) {
    const { count, name, tier } = schoolInfo;
    if (count >= 20) {
      school_text = `过去一年中，我们支持了超过20位来自${name}的researcher`;
    } else if (count >= 15) {
      school_text = `过去一年中，我们支持了接近20位来自${name}的researcher`;
    } else if (count >= 5) {
      school_text = `过去一年中，我们支持了${count}位来自${name}的researcher`;
    } else {
      school_text = tier === 1
        ? `过去一年中，我们支持了70+来自${name}、MIT、清华、北大等高校的项目`
        : `过去一年中，我们支持了70+来自MIT、清华、${name}等高校的项目`;
    }
  } else {
    school_text = "过去一年中，我们支持了70+前沿项目";
  }

  const directions_text = matchedDirections.length >= 2
    ? `，已经支持的研究方向包括${matchedDirections.join("、")}等`
    : "";

  return { school_text, base_info, directions_text };
}

// ── LLM-generated personalized intro ─────────────────────────────────
function sanitizeGeminiOutput(text: string): string {
  let t = text.trim();
  t = t.replace(/^[""\u201c]+/, "").replace(/[""\u201d]+$/, "");
  t = t.replace(/\*{1,3}(.+?)\*{1,3}/g, "$1");
  t = t.replace(/`/g, "");
  t = t.replace(/^[-•]\s*/, "");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

function sanitizePersonalizedIntro(text: string): string {
  let t = sanitizeGeminiOutput(text);
  t = t.replace(/[（(][^）)]*(?:个字|字以内|以内|注意|格式|例子|option|段论)[^）)]*[）)]/g, "");
  t = t.replace(/[（(]\d+个?字[）)]/g, "");
  t = t.replace(/，\s*，/g, "，");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

async function generatePersonalizedIntro(
  introPrompt: string,
  title: string,
  abstract: string,
): Promise<string> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_API_KEY not set");

  // Substitute {{title}} / {{abstract}} in the prompt template.
  const prompt = introPrompt
    .replace("{{title}}", title)
    .replace("{{abstract}}", abstract.slice(0, 1000));

  // Back-compat: if the template is a legacy one that doesn't reference
  // {{title}}, prepend the paper context so the LLM still has it.
  const finalPrompt = prompt.includes(title) ? prompt : `根据论文写一句个性化开头（1句话）。

标题: ${title}
摘要: ${abstract.slice(0, 1000)}

${prompt}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: finalPrompt }] }] }),
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const raw: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  return sanitizePersonalizedIntro(raw);
}

// ── Template loading ─────────────────────────────────────────────────
/**
 * Load the effective template for a rep:
 *   1. Per-rep template (name like "rep_<repname>") if active.
 *   2. Global template (name "global") otherwise.
 * Returns null if neither exists (caller should fall back to legacy
 * hardcoded generator).
 */
export async function loadEffectiveTemplate(repId: number | null): Promise<EmailTemplate | null> {
  if (repId !== null) {
    const { data: perRep } = await supabase
      .from("email_templates")
      .select("*")
      .eq("rep_id", repId)
      .eq("active", true)
      .maybeSingle();
    if (perRep) return perRep as EmailTemplate;
  }
  const { data: global } = await supabase
    .from("email_templates")
    .select("*")
    .eq("name", "global")
    .eq("active", true)
    .maybeSingle();
  return (global as EmailTemplate | null) ?? null;
}

// ── String substitution ──────────────────────────────────────────────
/**
 * Replace every {{key}} in `fmt` with (html-escaped) vars[key]. If a
 * token isn't in `vars`, it's left in place so missing-variable bugs
 * are visible rather than silent.
 */
function substitute(fmt: string, vars: Record<string, string>): string {
  return fmt.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
    const v = vars[key];
    if (typeof v !== "string") return `{{${key}}}`;
    return escapeHtml(v);
  });
}

/**
 * Same as substitute() but does NOT escape — for fields that are
 * already safe/static or pre-computed HTML. Use sparingly.
 */
function substituteRaw(fmt: string, vars: Record<string, string>): string {
  return fmt.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => vars[key] ?? `{{${key}}}`);
}

// ── Main assembler ───────────────────────────────────────────────────
export async function assembleDraft(
  template: EmailTemplate,
  input: AssemblyInput,
): Promise<{ subject: string; html: string }> {
  const schoolInfo = getSchoolInfo(input.authorEmail);

  const personalizedIntro = await generatePersonalizedIntro(
    template.intro_prompt,
    input.title,
    input.abstract,
  );

  const pitch = computeSchoolPitchVars(schoolInfo, input.matchedDirections);

  const fullTitle = input.title.replace(/\n/g, " ").trim();
  const firstNameOrYou = input.firstName ?? "你";
  const closingName = input.firstName ?? "你";

  // Subject: un-escaped {{title}} substitution because subject is
  // plain text (not HTML). Truncate at 200 chars.
  const subject = truncateSubject(
    substituteRaw(template.subject_format, { title: fullTitle }),
  );

  // Body parts — each gets its own placeholder set. Escape everywhere
  // except the CTA signoff, which contains an <a> tag that's part of
  // the template.
  const greeting = substitute(template.greeting_format, {
    first_name_or_you: firstNameOrYou,
  });
  const repIntro = substitute(template.rep_intro_format, {
    rep_name: input.repName,
  });
  const schoolPitch = substitute(template.school_pitch_format, {
    school_text: pitch.school_text,
    base_info: pitch.base_info,
    directions_text: pitch.directions_text,
    wechat_article_url: WECHAT_ARTICLE_URL,
  });
  // cta_signoff_format contains a literal <a href="{{apply_url}}"> —
  // we do TWO passes: first unescape-substitute the URL (it's trusted
  // server config), then html-escape the dynamic name/wechat fields.
  const ctaWithUrl = substituteRaw(template.cta_signoff_format, {
    apply_url: APPLY_URL_CTA,
  });
  const ctaSignoff = substitute(ctaWithUrl, {
    closing_name: closingName,
    rep_wechat: input.repWechatId,
  });

  // Personalized intro is the LLM output — escape it.
  const personalizedIntroHtml = escapeHtml(personalizedIntro);

  // Signature block (stable across templates — not worth templating).
  const signature = `<span style="font-size: 14px; color: #333; line-height: 1.6;">${escapeHtml(input.repName)}<br>奇绩创坛</span>`;

  const html = `<html>
<head><meta charset="utf-8"></head>
<body style="font-family: sans-serif; font-size: 14px; line-height: 1.8; color: #333;">
${greeting}<br><br>
${personalizedIntroHtml}<br><br>
${repIntro}<br><br>
${schoolPitch}<br><br>
${ctaSignoff}<br><br>
${signature}
</body></html>`;

  return { subject, html };
}
