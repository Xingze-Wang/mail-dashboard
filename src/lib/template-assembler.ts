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
): Promise<{ output: string; resolvedPrompt: string }> {
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

  // Route through MiraclePlus proxy. Direct Gemini
  // (generativelanguage.googleapis.com) returns
  // FAILED_PRECONDITION 'Your location is not supported' from Vercel
  // hkg1 IPs (China-region edge). Same fix the Python scanner needed.
  // The proxy supports the Gemini family via "gemini-3-flash" /
  // "gemini-2.5-flash" aliases — see src/lib/llm-proxy.ts:KNOWN_MODELS.
  const { llmChat } = await import("@/lib/llm-proxy");
  // gemini-3-flash (preview) has no implicit reasoning tokens; the
  // 2.5-flash variant on this proxy was burning 990+ tokens on
  // internal "thinking" before emitting visible output, leading to
  // finish_reason: length truncation at 55 chars. 3-flash is also
  // cheaper + faster for this paragraph-shape task.
  const r = await llmChat({
    model: "gemini-3-flash",
    user: finalPrompt,
    temperature: 0.5,
    // 2500 because gemini-flash variants on this proxy use internal
    // reasoning tokens that count against max_tokens. With the
    // hardened 1735-char system prompt + 1000-char abstract, smaller
    // budgets get truncated mid-output (finish_reason: length). 2500
    // gave ~1984 output tokens for full 3-clause Chinese intro.
    max_tokens: 2500,
    timeoutMs: 30_000,
  });
  return {
    output: sanitizePersonalizedIntro(r.text),
    resolvedPrompt: finalPrompt,
  };
}

// ── Template loading ─────────────────────────────────────────────────

/**
 * Percentage of production traffic that gets routed through an
 * approved_draft template (when one exists for the same segment).
 * 20% means ~1 in 5 sends in that segment go through the draft, the
 * rest through the active. Deterministic by lead id: a single lead
 * always gets the same template, so a regenerate-draft action stays
 * stable.
 *
 * Bumping this above 30% gets statistically faster signal but exposes
 * more recipients to an untested variant; below 10% almost never
 * accumulates the n needed for auto-promote (30 sends per template).
 */
const APPROVED_DRAFT_TRAFFIC_PCT = 20;

/**
 * Deterministic hash → bucket assignment. Same lead always falls into
 * the same bucket so a regenerate-draft / preview-on-pipeline action
 * doesn't flip the lead between active and draft. djb2-style.
 */
function hashToBucket(leadId: string | null | undefined, modulo: number): number {
  if (!leadId) return 0;
  let h = 5381;
  for (let i = 0; i < leadId.length; i++) {
    h = ((h << 5) + h + leadId.charCodeAt(i)) >>> 0;
  }
  return h % modulo;
}

/**
 * Load the effective template for a rep + lead pair.
 *
 *   1. Per-rep template (rep_id matches) if active.
 *   2. Otherwise the global active template, OPTIONALLY split between
 *      active and approved_draft for A/B-style traffic routing.
 *
 * The second arg `leadId` enables A/B splitting: when an active AND
 * an approved_draft both exist for the same segment_default, the lead
 * is hashed and ~APPROVED_DRAFT_TRAFFIC_PCT% land on the draft. This
 * gives the auto-promote cron the data it needs to decide.
 *
 * If `leadId` is null (e.g. preview / inspect), always returns the
 * active template — drafts only get exposed to actual production sends.
 */
/**
 * Inner helper — given a candidate active template + a list of
 * approved_draft templates targeting the same scope, pick which one
 * to use for this lead. Deterministic via the lead-id hash.
 *
 * Returns activeTpl when leadId is missing (preview / inspect),
 * when there are no drafts, or when this lead's bucket falls
 * outside the A/B split percentage.
 */
function pickWithABSplit(
  activeTpl: EmailTemplate,
  drafts: EmailTemplate[],
  leadId: string | null | undefined,
): EmailTemplate {
  if (!leadId || drafts.length === 0) return activeTpl;
  const bucket = hashToBucket(leadId, 100);
  if (bucket >= APPROVED_DRAFT_TRAFFIC_PCT) return activeTpl;
  const draftIdx = hashToBucket(leadId + "draft", drafts.length);
  return drafts[draftIdx];
}

export async function loadEffectiveTemplate(
  repId: number | null,
  leadId?: string | null,
): Promise<EmailTemplate | null> {
  // Layer 1: per-rep template (rep_id matches). When a rep has both
  // an active and one or more approved_draft templates, A/B split
  // applies here too — per-rep volume is small but if admin set up
  // a per-rep draft they explicitly want to test it.
  if (repId !== null) {
    const { data: perRepActive } = await supabase
      .from("email_templates")
      .select("*")
      .eq("rep_id", repId)
      .eq("active", true)
      .eq("status", "active")
      .maybeSingle();
    if (perRepActive) {
      const { data: perRepDrafts } = await supabase
        .from("email_templates")
        .select("*")
        .eq("rep_id", repId)
        .eq("active", true)
        .eq("status", "approved_draft");
      return pickWithABSplit(
        perRepActive as EmailTemplate,
        (perRepDrafts ?? []) as EmailTemplate[],
        leadId,
      );
    }
  }

  // Layer 2: org-wide global active template (the baseline).
  const { data: global } = await supabase
    .from("email_templates")
    .select("*")
    .eq("name", "global")
    .eq("active", true)
    .eq("status", "active")
    .maybeSingle();
  const activeTpl = (global as EmailTemplate | null) ?? null;
  if (!activeTpl) return null;

  const { data: orgDrafts } = await supabase
    .from("email_templates")
    .select("*")
    .eq("status", "approved_draft")
    .eq("active", true)
    .is("rep_id", null);
  return pickWithABSplit(activeTpl, (orgDrafts ?? []) as EmailTemplate[], leadId);
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
/**
 * Segment context derived from the lead. Lives only here — the values
 * are computed from AssemblyInput, never stored.
 */
interface SegmentContext {
  geo: "cn" | "edu" | "other";
  school_tier: number | null;
}

function deriveSegmentContext(input: AssemblyInput): SegmentContext {
  const lower = (input.authorEmail ?? "").toLowerCase();
  const geo: "cn" | "edu" | "other" =
    lower.endsWith(".cn") ? "cn"
    : (lower.endsWith(".edu") || lower.endsWith(".edu.cn")) ? "edu"
    : "other";
  return { geo, school_tier: input.schoolTier };
}

interface SlotOverride { slot_name: string; when: Record<string, unknown>; value: string }

/**
 * Pick the effective value for a slot. Returns the first matching
 * override (oldest first — matches insertion order) or the template
 * row's default. An override matches when every key in `when` is
 * present in ctx with the same value (string === string,
 * number === number).
 */
function pickSlot(
  template: EmailTemplate,
  slot: "subject_format" | "intro_prompt" | "greeting_format" | "rep_intro_format" | "school_pitch_format" | "cta_signoff_format",
  overrides: SlotOverride[],
  ctx: SegmentContext,
): string {
  const candidates = overrides.filter((o) => o.slot_name === slot);
  for (const o of candidates) {
    if (matchesContext(o.when, ctx)) return o.value;
  }
  return template[slot];
}

function matchesContext(when: Record<string, unknown>, ctx: SegmentContext): boolean {
  for (const [k, v] of Object.entries(when ?? {})) {
    if (k === "geo" && v !== ctx.geo) return false;
    if (k === "school_tier" && Number(v) !== ctx.school_tier) return false;
    // unknown keys are silently ignored — keeps additions forward-compat
  }
  return true;
}

/**
 * Per-paragraph provenance for the inspector view (`/templates/[id]/inspect`).
 *
 * Each "kind" tells the UI how to render the badge / explainer:
 *   - 'fixed': literal template text, no substitution other than
 *     trivial vars (rep_name placeholder, lead first_name)
 *   - 'segment_selected': the template defined multiple variants and
 *     the segment context picked one (`when` clause matched)
 *   - 'rule_computed': value computed from program rules (school
 *     pitch text picked by SCHOOL_DATA + directions)
 *   - 'ai_generated': LLM produced this — prompt + raw output also
 *     surface so admin can see the full sausage
 */
export type AssembledPartKind =
  | "fixed"
  | "segment_selected"
  | "rule_computed"
  | "ai_generated";

export interface AssembledPart {
  slot: string;                    // 'subject' | 'greeting' | 'intro' | 'rep_intro' | 'school_pitch' | 'cta_signoff' | 'signature'
  kind: AssembledPartKind;
  rendered: string;                // the final string for this part (HTML for body parts, plain for subject)
  source_format?: string;          // template's format string before substitution (for fixed/segment_selected/rule_computed)
  resolved_prompt?: string;        // for ai_generated: the full Gemini prompt
  selection_reason?: string;       // for segment_selected: which `when` clause matched
}

export async function assembleDraft(
  template: EmailTemplate,
  input: AssemblyInput,
): Promise<{
  subject: string;
  html: string;
  // Audit: the FULL prompt fed to Gemini for the personalized intro
  // (after {{title}}/{{abstract}} substitution + the back-compat
  // wrapper if the template was a legacy one). Send routes stamp this
  // onto emails.intro_prompt_resolved so downstream analytics can
  // trace "what went in" → "what came out".
  introPromptResolved: string;
  // The raw LLM output (post-sanitize, pre-HTML-escape). Same chunk
  // that becomes paragraph 2 of the email body. Stored on
  // emails.intro_output for predictor / rater training signal.
  introOutput: string;
  // Per-paragraph parts for the inspector view. Indexed by slot name.
  // Parts are computed from the same data assembleDraft already
  // produces, no extra LLM cost. Callers that don't need them can
  // ignore.
  parts: AssembledPart[];
}> {
  const schoolInfo = getSchoolInfo(input.authorEmail);
  const segmentCtx = deriveSegmentContext(input);

  // Pull all segment overrides for this template once. Cheap query
  // (indexed on template_id) and lets every slot pick from the same
  // in-memory list. Empty array if migration 034 hasn't run yet.
  let overrides: SlotOverride[] = [];
  try {
    const { data } = await supabase
      .from("email_template_overrides")
      .select("slot_name, when, value")
      .eq("template_id", template.id)
      .order("created_at", { ascending: true });
    overrides = (data ?? []) as SlotOverride[];
  } catch {
    // table missing — segment-aware path silently no-ops
  }

  const introResult = await generatePersonalizedIntro(
    pickSlot(template, "intro_prompt", overrides, segmentCtx),
    input.title,
    input.abstract,
  );
  const personalizedIntro = introResult.output;

  const pitch = computeSchoolPitchVars(schoolInfo, input.matchedDirections);

  const fullTitle = input.title.replace(/\n/g, " ").trim();
  const firstNameOrYou = input.firstName ?? "你";
  const closingName = input.firstName ?? "你";

  // Subject: un-escaped {{title}} substitution because subject is
  // plain text (not HTML). Truncate at 200 chars.
  const subject = truncateSubject(
    substituteRaw(pickSlot(template, "subject_format", overrides, segmentCtx), { title: fullTitle }),
  );

  // Body parts — each gets its own placeholder set. Escape everywhere
  // except the CTA signoff, which contains an <a> tag that's part of
  // the template.
  //
  // CRITICAL: rep-specific values (rep_name, rep_wechat, closing_name)
  // are NOT resolved here. They stay as {{REP_NAME}} / {{REP_WECHAT}} /
  // {{CLOSING_NAME}} placeholders so the draft can survive a
  // reassignment without rebake. Final resolution happens in
  // resolveLatePlaceholders() at send/preview time against the CURRENT
  // assigned_rep_id. (Lead-specific values like first_name DO resolve
  // here — they don't change with reassignment.)
  const greeting = substitute(pickSlot(template, "greeting_format", overrides, segmentCtx), {
    first_name_or_you: firstNameOrYou,
  });
  // rep_name placeholder kept; substitute() ignores unknown {{...}}
  // tokens (returns them as-is per its loop), but we want UPPERCASE
  // sentinels so we can distinguish "send-time resolved" from regular
  // template tokens. Inject the sentinel directly via substituteRaw.
  const repIntro = substituteRaw(
    pickSlot(template, "rep_intro_format", overrides, segmentCtx),
    { rep_name: "{{REP_NAME}}" },
  );
  const schoolPitch = substitute(pickSlot(template, "school_pitch_format", overrides, segmentCtx), {
    school_text: pitch.school_text,
    base_info: pitch.base_info,
    directions_text: pitch.directions_text,
    wechat_article_url: WECHAT_ARTICLE_URL,
  });
  // cta_signoff_format contains a literal <a href="{{apply_url}}"> —
  // we do TWO passes: first unescape-substitute the URL (it's trusted
  // server config), then leave rep_wechat + closing_name as sentinels.
  const ctaWithUrl = substituteRaw(pickSlot(template, "cta_signoff_format", overrides, segmentCtx), {
    apply_url: APPLY_URL_CTA,
  });
  const ctaSignoff = substituteRaw(ctaWithUrl, {
    closing_name: "{{CLOSING_NAME}}",
    rep_wechat: "{{REP_WECHAT}}",
  });

  // Personalized intro is the LLM output — escape it.
  const personalizedIntroHtml = escapeHtml(personalizedIntro);

  // Signature is now also a placeholder. resolveLatePlaceholders fills
  // it from current rep state. closingName is left here unused —
  // resolveLatePlaceholders will fold the rep_name sentinel pattern.
  void closingName;
  const signature = `<span style="font-size: 14px; color: #333; line-height: 1.6;">{{REP_NAME}}<br>奇绩创坛</span>`;

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

  // Per-paragraph provenance for inspector view. Kept as a flat array
  // in slot order — easy to map to badges in the UI. Each part records
  // the source_format so admin can see "this is what the template
  // says before substitution". For ai_generated, resolved_prompt is
  // the full prompt fed to Gemini.
  const parts: AssembledPart[] = [
    {
      slot: "subject",
      kind: hasMatchingOverride(overrides, "subject_format", segmentCtx)
        ? "segment_selected"
        : "fixed",
      rendered: subject,
      source_format: pickSlot(template, "subject_format", overrides, segmentCtx),
      selection_reason: matchReason(overrides, "subject_format", segmentCtx),
    },
    {
      slot: "greeting",
      kind: hasMatchingOverride(overrides, "greeting_format", segmentCtx)
        ? "segment_selected"
        : "fixed",
      rendered: greeting,
      source_format: pickSlot(template, "greeting_format", overrides, segmentCtx),
      selection_reason: matchReason(overrides, "greeting_format", segmentCtx),
    },
    {
      slot: "intro",
      kind: "ai_generated",
      rendered: personalizedIntroHtml,
      resolved_prompt: introResult.resolvedPrompt,
    },
    {
      slot: "rep_intro",
      kind: hasMatchingOverride(overrides, "rep_intro_format", segmentCtx)
        ? "segment_selected"
        : "fixed",
      rendered: repIntro,
      source_format: pickSlot(template, "rep_intro_format", overrides, segmentCtx),
      selection_reason: matchReason(overrides, "rep_intro_format", segmentCtx),
    },
    {
      slot: "school_pitch",
      // school_pitch ALWAYS includes rule-computed values (school_text
      // from SCHOOL_DATA), so even if the format is fixed it's
      // effectively rule_computed.
      kind: "rule_computed",
      rendered: schoolPitch,
      source_format: pickSlot(template, "school_pitch_format", overrides, segmentCtx),
      selection_reason: schoolInfo
        ? `school=${schoolInfo.name}, count=${schoolInfo.count}, tier=${schoolInfo.tier}`
        : "no school info — fallback pitch",
    },
    {
      slot: "cta_signoff",
      kind: hasMatchingOverride(overrides, "cta_signoff_format", segmentCtx)
        ? "segment_selected"
        : "fixed",
      rendered: ctaSignoff,
      source_format: pickSlot(template, "cta_signoff_format", overrides, segmentCtx),
      selection_reason: matchReason(overrides, "cta_signoff_format", segmentCtx),
    },
    {
      slot: "signature",
      kind: "fixed",
      rendered: signature,
      source_format: signature,
    },
  ];

  return {
    subject,
    html,
    introPromptResolved: introResult.resolvedPrompt,
    introOutput: introResult.output,
    parts,
  };
}

/** Did any override clause match this segmentCtx for the given slot? */
function hasMatchingOverride(
  overrides: SlotOverride[],
  slot: string,
  ctx: SegmentContext,
): boolean {
  for (const o of overrides) {
    if (o.slot_name !== slot) continue;
    if (matchesContext(o.when, ctx)) return true;
  }
  return false;
}

/** Human-readable description of which `when` clause matched. Empty
 *  when no override fired — caller should not display a reason. */
function matchReason(
  overrides: SlotOverride[],
  slot: string,
  ctx: SegmentContext,
): string | undefined {
  for (const o of overrides) {
    if (o.slot_name !== slot) continue;
    if (matchesContext(o.when, ctx)) {
      return `matched: ${JSON.stringify(o.when)}`;
    }
  }
  return undefined;
}

/**
 * Resolve the late-binding {{REP_*}} placeholders against the current
 * rep state. Called at send time AND at preview time so the same draft
 * shows the right rep no matter who's currently assigned.
 *
 * Inputs:
 *   - html / subject: the partially-resolved draft from assembleDraft
 *     (or any prior render). Lead-specific tokens are already gone;
 *     only rep-specific UPPERCASE sentinels remain: {{REP_NAME}},
 *     {{REP_WECHAT}}, {{CLOSING_NAME}}.
 *   - repName / repWechat: the values to inject. closingName defaults
 *     to repName since that's what the old assembler used.
 *
 * Returns the fully-resolved html + subject. If any sentinels were
 * actually present, also returns the original strings substituted
 * count so callers can audit-log whether resolution did real work.
 *
 * Why HTML-escape only repName for the body but not for the subject:
 * the subject is plain text (gets put in the email's Subject header
 * by Resend), HTML escapes there would render as &amp; in the user's
 * inbox. Body content goes into HTML, so it MUST be escaped.
 */
export function resolveLatePlaceholders(args: {
  html: string;
  subject: string;
  repName: string;
  repWechat: string | null | undefined;
  closingName?: string | null;
}): { html: string; subject: string; resolvedCount: number } {
  const escName = escapeHtml(args.repName);
  const escWechat = escapeHtml(args.repWechat ?? "");
  const escClosing = escapeHtml((args.closingName ?? args.repName).trim());

  let html = args.html;
  let subject = args.subject;
  let count = 0;

  const swap = (haystack: string, needle: string, replace: string) => {
    if (!haystack.includes(needle)) return haystack;
    count++;
    return haystack.split(needle).join(replace);
  };

  html = swap(html, "{{REP_NAME}}", escName);
  html = swap(html, "{{REP_WECHAT}}", escWechat);
  html = swap(html, "{{CLOSING_NAME}}", escClosing);

  // Subject: use raw rep name (no HTML escape).
  subject = swap(subject, "{{REP_NAME}}", args.repName);
  subject = swap(subject, "{{REP_WECHAT}}", args.repWechat ?? "");
  subject = swap(subject, "{{CLOSING_NAME}}", (args.closingName ?? args.repName).trim());

  return { html, subject, resolvedCount: count };
}
