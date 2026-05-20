// Paper-type classifier — log-only signal (no gate).
//
// Per 2026-05-20 product call: classify each new lead's paper into one of
// 8 buckets (see migration 105) and log to pipeline_leads.paper_type +
// paper_type_reason. Used for analytics — we want to learn which paper
// types convert before deciding whether any type should be filtered.
//
// Two-tier approach:
//   1. Deterministic keyword pass (free) catches the obvious cases:
//      "survey", "benchmark", "we prove", "null result", etc.
//   2. LLM fallback (Gemini direct, ~$0.0005 + ~1s) for ambiguous cases.
//
// Best-effort: returns "unknown" on any failure rather than throwing.
// Caller should NOT block import on a classification failure.

export type PaperType =
  | "empirical_method"
  | "benchmark"
  | "theory"
  | "survey"
  | "null_result"
  | "measurement"
  | "position"
  | "unknown";

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_TIMEOUT_MS = 15_000;

interface DeterministicHit {
  type: PaperType;
  confidence: number;  // 0-1
  reason: string;
}

function tryDeterministic(title: string, abstract: string): DeterministicHit | null {
  const t = (title || "").toLowerCase();
  const a = (abstract || "").toLowerCase();
  const ta = `${t} ${a}`;

  // Survey: strong title signal
  if (/\bsurvey\b|\ba review\b|\bsystematic review\b/i.test(title) || /\bwe survey\b|\bwe review\b/.test(a)) {
    return { type: "survey", confidence: 0.95, reason: "title/abstract uses 'survey' / 'review' framing" };
  }

  // Benchmark: strong title signal
  if (/\bbenchmark\b|\bevaluation suite\b/i.test(title) && !/\bbeyond benchmark\b/i.test(title)) {
    return { type: "benchmark", confidence: 0.9, reason: "title declares a benchmark" };
  }
  if (/\b(we introduce|we present|we propose) (?:a |the )?(?:new )?benchmark\b/.test(a)) {
    return { type: "benchmark", confidence: 0.85, reason: "abstract announces a new benchmark" };
  }

  // Theory / formal: explicit theorem / proof / Lean / Coq vocab
  if (/\bwe prove\b|\bwe show that\b.*\btheorem\b|\b(?:lean|coq|isabelle)\s*4?\b|\bformal verification\b/.test(a)) {
    return { type: "theory", confidence: 0.9, reason: "abstract uses formal-proof vocabulary" };
  }

  // Null-result: explicit statement
  if (/\bnull result\b|\bdoes not (?:significantly )?(?:improve|help|modulate|matter)\b|\bcontrary to\b.*\bexpectation/.test(a)) {
    return { type: "null_result", confidence: 0.85, reason: "abstract claims a null / negative result" };
  }

  // Position: explicit framing
  if (/\bposition (?:paper|piece)\b|\bwe argue (?:that|for)\b|\bperspective\b.*\bon\b/.test(ta)) {
    return { type: "position", confidence: 0.8, reason: "framed as position / argument paper" };
  }

  // Measurement / characterization: empirical study of existing systems
  if (/\bwe (?:measure|characterize|analyze|investigate|study)\b.*\b(?:existing|prior|deployed)\b/.test(a)
      && !/\bwe (?:propose|introduce|present)\b/.test(a)) {
    return { type: "measurement", confidence: 0.75, reason: "abstract is measurement-only (no new method)" };
  }

  // Empirical method: catch-all positive — "we propose / introduce / present a (method/model/framework)"
  if (/\b(?:we (?:propose|introduce|present)|in this (?:paper|work),? we) .{0,80}\b(?:method|model|framework|approach|architecture|algorithm|technique|system|tool|pipeline)\b/.test(a)) {
    return { type: "empirical_method", confidence: 0.7, reason: "abstract announces a new method/model/framework" };
  }

  return null;
}

const LLM_PROMPT = (title: string, abstract: string) => `Classify the following research paper into ONE of these categories:

- empirical_method: builds a new method/model/framework with empirical results
- benchmark: introduces an evaluation benchmark or eval suite
- theory: proves theorems or provides formal/mathematical results
- survey: synthesizes prior work, no new contribution
- null_result: reports that an expected effect did NOT occur
- measurement: characterizes/analyzes existing systems without proposing new ones
- position: argues a viewpoint without primary experimental contribution
- unknown: doesn't fit any above

Title: ${title}
Abstract: ${(abstract || "").slice(0, 1200)}

Return JSON only:
{"type": "<one_of_above>", "reason": "<one_sentence>"}`;

async function callGeminiClassify(title: string, abstract: string): Promise<{ type: PaperType; reason: string } | null> {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: LLM_PROMPT(title, abstract) }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 800 },
        }),
        signal: controller.signal,
      },
    );
    if (!res.ok) return null;
    const j = await res.json();
    const text = j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    let cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first >= 0 && last > first) cleaned = cleaned.slice(first, last + 1);
    const parsed = JSON.parse(cleaned);
    const type = String(parsed.type || "").toLowerCase() as PaperType;
    const valid: PaperType[] = ["empirical_method", "benchmark", "theory", "survey", "null_result", "measurement", "position", "unknown"];
    if (!valid.includes(type)) return null;
    return { type, reason: String(parsed.reason || "").slice(0, 200) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Classify a paper into one of 8 types. Never throws. Returns "unknown"
 * + a reason on any failure. Use `awaitLlm=false` to skip the LLM
 * fallback (e.g. during high-volume backfills where deterministic-only
 * is fine).
 */
export async function classifyPaperType(args: {
  title: string;
  abstract: string;
  awaitLlm?: boolean;
}): Promise<{ type: PaperType; reason: string }> {
  // (1) Deterministic — cheap and fast
  const det = tryDeterministic(args.title || "", args.abstract || "");
  if (det && det.confidence >= 0.8) {
    return { type: det.type, reason: `det: ${det.reason}` };
  }

  // (2) LLM fallback for ambiguous cases (or override above 0.7 threshold)
  if (args.awaitLlm !== false) {
    const llm = await callGeminiClassify(args.title || "", args.abstract || "");
    if (llm) return { type: llm.type, reason: `llm: ${llm.reason}` };
  }

  // (3) Fall back to deterministic result if we got one (even if lower confidence)
  if (det) return { type: det.type, reason: `det-weak: ${det.reason}` };

  return { type: "unknown", reason: "no signal" };
}
