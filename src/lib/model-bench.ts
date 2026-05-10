// src/lib/model-bench.ts
// ════════════════════════════════════════════════════════════════════
// Shared evaluator for the three prediction models (mig 078). Used by
//   - GET /api/cron/model-bench-eval (daily 08:00 UTC) to produce
//     fresh predictions for new emails / new templates
//   - GET /api/admin/model-bench (the leaderboard page) to display
//     calibration / agreement stats for each (kind, prompt) row
//
// The three model families:
//   1. persona_recipient   → predicts (p_click, p_apply) given a
//      lead's persona archetype + the email body. Backtest target:
//      did the actual recipient click? did the lead reach
//      brief_lookups.added_wechat=true?
//   2. email_quality_judge → predicts (would_approve, scores) given
//      a new template proposal. Backtest target: did admin actually
//      approve (status=active) or reject (status=archived +
//      rejection_reason)?
//   3. ctr_regressor       → predicts P(click) from lead+email
//      features only (no persona acting). Calibration target:
//      observed click rate per predicted-bucket.
// ════════════════════════════════════════════════════════════════════

import { llmChat } from "@/lib/llm-proxy";
import { supabase } from "@/lib/db";
import { createHash } from "node:crypto";

export type PromptRow = {
  id: string;
  kind: "persona_recipient" | "email_quality_judge" | "ctr_regressor";
  name: string;
  persona_archetype: string | null;
  system_prompt: string;
  llm_model: string;
};

// ───────────── Persona archetypes ────────────────────────────────────
// Derived from features we already harvest. The eval picks the
// closest archetype per lead at backtest time so we don't ask the
// "junior_phd_tier1" prompt to predict for a senior PI lead.

export type Archetype =
  | "junior_phd_tier1"
  | "junior_phd_tier2_3"
  | "senior_pi_tier1"
  | "senior_pi_tier2_3"
  | "industry_researcher"
  | "postdoc_or_junior_faculty"
  | "unknown";

export function classifyArchetype(args: {
  school_tier: number | null;
  h_index: number | null;
  citation_count: number | null;
  author_email: string | null;
  school_name: string | null;
}): Archetype {
  const e = (args.author_email ?? "").toLowerCase();
  const isPersonal = /(@gmail|@outlook|@hotmail|@163|@qq|@foxmail|@yahoo|@126|@icloud|@me\.com)/.test(e);
  // Industry: known industry domains, or non-edu non-personal mail
  const indus = /(@(alibaba|tencent|baidu|bytedance|huawei|microsoft|google|meta|amazon|apple|nvidia|ibm|sony|antgroup|meituan|ant|jd\.com|kuaishou|sensetime|deepmind|openai)\.)/.test(e);
  if (indus) return "industry_researcher";

  const tier = args.school_tier ?? 0;
  const h = args.h_index ?? 0;
  const c = args.citation_count ?? 0;

  // Senior signals: h≥30, OR citations≥5000, OR domain part suggests faculty
  const seniorSignal = h >= 30 || c >= 5000;
  // Junior signals: numeric digits > 4 in email local-part (student id pattern), OR personal email + low h
  const juniorSignal = /^[a-z]{1,4}\d{6,}@/.test(e) || (isPersonal && h < 10);

  if (seniorSignal) {
    if (tier === 1) return "senior_pi_tier1";
    return "senior_pi_tier2_3";
  }
  if (juniorSignal) {
    if (tier === 1) return "junior_phd_tier1";
    return "junior_phd_tier2_3";
  }
  // Mid-career or unknown — postdoc / new faculty bucket
  if (h >= 5 || c >= 200) return "postdoc_or_junior_faculty";
  return "unknown";
}

// ───────────── Per-kind LLM call ─────────────────────────────────────

// Empirically Gemini and Claude both like to preamble ("Here is the
// JSON:") and wrap in ```json fences even with response_format=
// json_object set. The fence stripper handles that. We also have to
// hard-cap reasoning length — Gemini hit finish_reason=length at
// max_tokens=1500 with verbose Chinese reasoning, so we both bump
// the budget AND tell the model to keep reasoning terse.
const NO_PREAMBLE = "\n\nIMPORTANT: Output ONLY the JSON object — no preamble, no markdown fences, no commentary. The first character must be { and the last character must be }. Keep `reasoning` to ≤25 words total — over-long reasoning will be truncated and break the response.";

export async function evaluatePersonaRecipient(prompt: PromptRow, args: {
  archetype: Archetype;
  email_subject: string;
  email_body: string;
  lead_summary: string;
}): Promise<{ p_click: number; p_apply: number; reasoning: string }> {
  const userMsg = JSON.stringify({
    your_persona: args.archetype,
    lead_context: args.lead_summary,
    email: { subject: args.email_subject, body: args.email_body.slice(0, 4000) },
    instructions: "Imagine you ARE this persona. You just received this email. Output JSON: {p_click: 0..1, p_apply: 0..1, reasoning: <2 sentences>}." + NO_PREAMBLE,
  });
  const out = await llmChat({
    model: prompt.llm_model,
    system: prompt.system_prompt,
    user: userMsg,
    json: true,
    max_tokens: 2500,
    temperature: 0.4,
    timeoutMs: 45_000,
  });
  return parseJsonish<{ p_click: number; p_apply: number; reasoning: string }>(out.text);
}

export async function evaluateEmailQuality(prompt: PromptRow, args: {
  template_name: string;
  rendered_sample: string;
  segment: string | null;
}): Promise<{ craft_score: number; voice_score: number; segment_fit: number; would_approve: boolean; reasoning: string }> {
  const userMsg = JSON.stringify({
    template_name: args.template_name,
    rendered_sample: args.rendered_sample.slice(0, 4000),
    segment: args.segment,
    instructions: "Rate this template proposal as if you are a senior sales lead reviewing it. Output JSON: {craft_score: 1-5, voice_score: 1-5, segment_fit: 1-5, would_approve: bool, reasoning: <2 sentences>}." + NO_PREAMBLE,
  });
  const out = await llmChat({
    model: prompt.llm_model,
    system: prompt.system_prompt,
    user: userMsg,
    json: true,
    max_tokens: 2500,
    temperature: 0.3,
    timeoutMs: 45_000,
  });
  return parseJsonish<{ craft_score: number; voice_score: number; segment_fit: number; would_approve: boolean; reasoning: string }>(out.text);
}

export async function evaluateCtrRegressor(prompt: PromptRow, args: {
  lead_summary: string;
  email_subject: string;
  email_body: string;
}): Promise<{ p_click: number; reasoning: string }> {
  const userMsg = JSON.stringify({
    lead: args.lead_summary,
    email: { subject: args.email_subject, body: args.email_body.slice(0, 4000) },
    instructions: "Predict the probability this email is clicked. Output JSON: {p_click: 0..1, reasoning: <1 sentence>}." + NO_PREAMBLE,
  });
  const out = await llmChat({
    model: prompt.llm_model,
    system: prompt.system_prompt,
    user: userMsg,
    json: true,
    max_tokens: 1500,
    temperature: 0.2,
    timeoutMs: 45_000,
  });
  return parseJsonish<{ p_click: number; reasoning: string }>(out.text);
}

// ───────────── JSON parsing — same defensive cleaner ─────────────────
// LLM JSON output is messy in practice. Order of strip operations:
// 1. ```json fences (Gemini, Claude both wrap)
// 2. preamble text before the first { (Gemini "Here is the JSON:")
// 3. trailing text after the last } (Claude sometimes adds a footer)
// 4. trailing commas before } / ] (any model getting too creative)
// 5. unescaped newlines inside strings — replaced with \\n so parse
//    succeeds. Common with Chinese reasoning text that has line breaks.
function parseJsonish<T>(raw: string): T {
  let cleaned = raw.trim();
  // Strip code fences
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
  // Find the JSON object: from first { to last }
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }
  cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Last-ditch: escape literal newlines that broke a string mid-flight.
    const escaped = cleaned.replace(/("(?:[^"\\]|\\.)*?)([\r\n])/g, (_m, prefix, nl) => prefix + (nl === "\n" ? "\\n" : "\\r"));
    return JSON.parse(escaped) as T;
  }
}

// ───────────── Shared pre-flight + write ─────────────────────────────

export function promptHash(systemPrompt: string): string {
  return createHash("sha256").update(systemPrompt).digest("hex").slice(0, 16);
}

export async function writePrediction(args: {
  prompt: PromptRow;
  email_id: string | null;
  template_id: string | null;
  prediction: object;
  headline: number;
  llm_model: string;
  llm_latency_ms: number;
}): Promise<void> {
  await supabase.from("model_predictions").insert({
    prompt_id: args.prompt.id,
    kind: args.prompt.kind,
    email_id: args.email_id,
    template_id: args.template_id,
    prediction: args.prediction,
    headline: args.headline,
    llm_model: args.llm_model,
    llm_latency_ms: args.llm_latency_ms,
    prompt_version_hash: promptHash(args.prompt.system_prompt),
  });
}
