/**
 * Server-side fallback scorer — estimates lead quality (0-1) via an LLM
 * when Python's trained classifier wasn't in the loop.
 *
 * Routes through the MiraclePlus proxy so we get multi-provider resilience
 * and can A/B flash-tier models without touching code. Model is overridable
 * via SCORER_MODEL env var; default is gemini-3-flash.
 *
 * Name kept as `scoreWithGemini` for callsite compatibility — callers
 * don't care which flash model we actually use.
 */

import { llmChat } from "@/lib/llm-proxy";

// Override with SCORER_MODEL=claude-haiku / gpt-5-nano / etc. for cheap A/B.
const DEFAULT_MODEL = "gemini-3-flash";

const SYSTEM = `You are a lead-quality scorer for a GPU-compute sales outreach system.
A good lead is a researcher whose paper suggests they need significant compute
AND who is likely to respond positively to a free-credits offer (e.g. heavy
training, frontier model work, academic lab without big-co affiliation).

Rate papers from 0.00 (very poor lead) to 1.00 (excellent lead).
Return ONLY a JSON object: {"score": 0.xx}`;

export async function scoreWithGemini(
  title: string,
  abstract: string,
): Promise<number | null> {
  if (!process.env.MIRACLEPLUS_PROXY_KEY) return null;

  const user = `Title: ${title.slice(0, 400)}\nAbstract: ${abstract.slice(0, 1500)}`;
  const model = process.env.SCORER_MODEL || DEFAULT_MODEL;

  try {
    const r = await llmChat({
      model,
      system: SYSTEM,
      user,
      temperature: 0.1,
      max_tokens: 40,
      json: true,
      timeoutMs: 8_000,
    });
    const match = r.text.match(/\{[^{}]*"score"\s*:\s*([\d.]+)[^{}]*\}/);
    if (!match) return null;
    const score = parseFloat(match[1]);
    if (isNaN(score) || score < 0 || score > 1) return null;
    return score;
  } catch {
    return null;
  }
}
