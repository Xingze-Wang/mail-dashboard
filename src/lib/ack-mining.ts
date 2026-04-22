// Pull industry signals from arxiv paper acknowledgments.
//
// Strategy:
//   1. Fetch ar5iv HTML (https://ar5iv.labs.arxiv.org/html/<id>) — works
//      reliably for 99%+ of arxiv papers and is fast (no PDF parsing).
//   2. Strip to text, find acknowledgment / footnote / author-block
//      sections.
//   3. Run intern-context regex + the org whitelist over those sections.
//
// Returns canonical org names + a confidence flag. We tolerate failure
// silently — ack mining is a nice-to-have signal, not critical path.

import { detectOrgsFromAck } from "@/lib/industry-orgs";

export interface AckResult {
  orgs: string[];
  source: "ack_strong" | "ack_weak" | "none";
}

const FETCH_TIMEOUT_MS = 8000;
const TEXT_LIMIT = 200_000; // ar5iv pages are big; cap to keep memory sane

export async function mineAckIndustry(arxivId: string | null): Promise<AckResult> {
  if (!arxivId) return { orgs: [], source: "none" };

  // Strip version suffix and any "v1" etc. ar5iv accepts both.
  const cleanId = arxivId.replace(/v\d+$/i, "").trim();
  if (!/^\d{4}\.\d{4,6}/.test(cleanId)) return { orgs: [], source: "none" };

  let html = "";
  try {
    const res = await fetch(`https://ar5iv.labs.arxiv.org/html/${cleanId}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      // ar5iv requires a UA to not 403
      headers: { "User-Agent": "QijiPipeline/1.0 (research outreach)" },
    });
    if (!res.ok) return { orgs: [], source: "none" };
    html = (await res.text()).slice(0, TEXT_LIMIT);
  } catch {
    return { orgs: [], source: "none" };
  }

  // Pull out candidate sections — ack, footnotes, author block. We don't
  // care about precision here; we just want to limit text we scan to the
  // areas where intern/affiliation mentions live (so a paper that cites
  // OpenAI's GPT-4 in the body doesn't false-positive as "worked at OpenAI").
  const sections: string[] = [];

  // Ack section — h2/h3/section labelled "acknowledg…"
  const ackMatches = html.match(/<(?:section|div|h[1-6])[^>]*>[\s\S]*?(?:acknowledg|funding)[\s\S]*?(?=<(?:section|h[1-6])\b|<\/body>)/gi);
  if (ackMatches) sections.push(...ackMatches);

  // Footnotes / author affiliation footers
  const footMatches = html.match(/<(?:span|div|li|footnote)[^>]*class="[^"]*(?:footnote|author|affiliation)[^"]*"[^>]*>[\s\S]*?<\/(?:span|div|li|footnote)>/gi);
  if (footMatches) sections.push(...footMatches);

  // First 5KB — author block usually lives in the head of the paper
  sections.push(html.slice(0, 5000));

  if (sections.length === 0) return { orgs: [], source: "none" };

  const text = sections.join("\n\n").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const { orgs, strongMatch } = detectOrgsFromAck(text);
  if (orgs.length === 0) return { orgs: [], source: "none" };
  return { orgs, source: strongMatch ? "ack_strong" : "ack_weak" };
}
