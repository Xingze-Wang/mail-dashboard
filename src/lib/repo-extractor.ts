// Extract HF + GitHub repo references from arxiv paper text.
// Most ML papers link their code in the abstract or in a footnote on page 1.
// We pull from:
//   - the arxiv abstract (cheap, always available)
//   - the paper's HuggingFace papers page if indexed (huggingface.co/papers/<arxiv_id>)
//
// Returns the most likely (hf_repo, github_repo) pair. The output format is
// "owner/name" (no protocol/host) so two papers pointing at the same project
// produce identical strings — that's what the dedup gate compares.

const HF_PATTERN = /(?:huggingface\.co\/(?:models?\/|datasets?\/|spaces\/)?)([\w-]+\/[\w.-]+)/gi;
const GH_PATTERN = /github\.com\/([\w-]+\/[\w.-]+)/gi;

function normalize(repo: string): string {
  // Strip trailing punctuation/markdown noise that often follows URLs in
  // abstracts: "github.com/foo/bar." or "github.com/foo/bar)."
  return repo.replace(/[.,)\]\s]+$/, "").trim();
}

function pickBest(matches: string[]): string | null {
  if (matches.length === 0) return null;
  // Common false positives:
  //   - github.com/anonymous (review-time placeholders)
  //   - github.com/<username>/repo for non-author repos referenced in the
  //     abstract (rarer; we don't try to filter these)
  //   - models/ or datasets/ on HF that are upstream models, not the author's
  //     project (rarer; we trust the abstract author's choice of link)
  const filtered = matches.filter((r) => {
    const lower = r.toLowerCase();
    return !lower.startsWith("anonymous/") && !lower.startsWith("anon/");
  });
  // Pick the most-frequently-mentioned (deduped count)
  const counts = new Map<string, number>();
  for (const r of filtered) counts.set(r, (counts.get(r) ?? 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return sorted.length > 0 ? sorted[0][0] : null;
}

export interface ExtractedRepos {
  hf_repo: string | null;
  github_repo: string | null;
  source: "abstract" | "hf-page" | "none";
}

/**
 * Extract HF + GitHub repos from an abstract string.
 */
export function extractFromText(text: string): ExtractedRepos {
  if (!text) return { hf_repo: null, github_repo: null, source: "none" };
  const hfMatches = [...text.matchAll(HF_PATTERN)].map((m) => normalize(m[1]));
  const ghMatches = [...text.matchAll(GH_PATTERN)].map((m) => normalize(m[1]));
  const hf = pickBest(hfMatches);
  const gh = pickBest(ghMatches);
  const source: "abstract" | "none" = hf || gh ? "abstract" : "none";
  return { hf_repo: hf, github_repo: gh, source };
}

/**
 * Try the HuggingFace papers page for an arxiv id — when the paper is
 * indexed, HF surfaces "Models citing this paper" and "Datasets citing this
 * paper" which gives a high-confidence repo link.
 */
export async function extractFromHuggingFacePage(arxivId: string): Promise<ExtractedRepos> {
  const url = `https://huggingface.co/papers/${encodeURIComponent(arxivId)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { hf_repo: null, github_repo: null, source: "none" };
    const html = await res.text();
    const ext = extractFromText(html);
    if (ext.hf_repo || ext.github_repo) return { ...ext, source: "hf-page" };
    return { hf_repo: null, github_repo: null, source: "none" };
  } catch {
    return { hf_repo: null, github_repo: null, source: "none" };
  }
}

/**
 * Combined: try abstract first (cheap), fall back to HF papers page.
 */
export async function extractRepos(args: {
  arxivId: string;
  abstract: string | null;
}): Promise<ExtractedRepos> {
  if (args.abstract) {
    const fromAbstract = extractFromText(args.abstract);
    if (fromAbstract.hf_repo || fromAbstract.github_repo) return fromAbstract;
  }
  return extractFromHuggingFacePage(args.arxivId);
}
