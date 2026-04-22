// Semantic Scholar API client for author h-index/citation lookup

const S2_BASE = "https://api.semanticscholar.org/graph/v1";
const S2_DELAY_MS = 1100; // stay under 1 req/sec

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface S2AuthorInfo {
  authorId: string;
  hIndex: number | null;
  citationCount: number | null;
  paperCount: number | null;
  /** Free-text affiliation strings as S2 has them. Multiple if the author
   *  bounced between orgs. Used by industry-orgs detector to flag OpenAI/
   *  Anyscale/etc. */
  affiliations: string[];
}

/** Check if all parts of name A appear in name B (handles name order differences) */
function namesMatch(target: string, candidate: string): boolean {
  const targetParts = target.toLowerCase().replace(/\s+/g, " ").trim().split(" ");
  const candidateParts = candidate.toLowerCase().replace(/\s+/g, " ").trim().split(" ");
  return targetParts.every((p) => candidateParts.some((c) => c === p));
}

/** Fetch author details by S2 author ID */
async function fetchAuthorDetails(authorId: string): Promise<S2AuthorInfo | null> {
  const res = await fetch(
    `${S2_BASE}/author/${authorId}?fields=hIndex,citationCount,paperCount,affiliations`,
    { signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) return null;
  const data = await res.json();
  return {
    authorId,
    hIndex: data.hIndex ?? null,
    citationCount: data.citationCount ?? null,
    paperCount: data.paperCount ?? null,
    affiliations: Array.isArray(data.affiliations)
      ? data.affiliations.map((s: unknown) => String(s)).filter(Boolean)
      : [],
  };
}

/**
 * Strategy 1: Search for the paper by title, then find the matching author.
 * Works well for papers already indexed on S2.
 */
async function lookupViaPaper(
  paperTitle: string,
  authorName: string,
): Promise<S2AuthorInfo | null> {
  const query = encodeURIComponent(paperTitle.slice(0, 200));
  const paperRes = await fetch(
    `${S2_BASE}/paper/search?query=${query}&limit=3&fields=title,authors`,
    { signal: AbortSignal.timeout(10_000) },
  );

  if (!paperRes.ok) return null;
  const paperData = await paperRes.json();
  const papers = paperData?.data ?? [];
  if (papers.length === 0) return null;

  for (const paper of papers) {
    for (const author of paper.authors ?? []) {
      if (namesMatch(authorName, author.name ?? "") && author.authorId) {
        await sleep(S2_DELAY_MS);
        return fetchAuthorDetails(author.authorId);
      }
    }
  }
  return null;
}

/**
 * Strategy 2: Search for the author directly by name.
 * Handles cases where the paper is too new to be indexed but the author
 * already has an S2 profile from previous publications.
 */
async function lookupViaAuthor(
  authorName: string,
): Promise<S2AuthorInfo | null> {
  const query = encodeURIComponent(authorName);
  const res = await fetch(
    `${S2_BASE}/author/search?query=${query}&limit=5&fields=name,hIndex,citationCount,paperCount,affiliations`,
    { signal: AbortSignal.timeout(10_000) },
  );

  if (!res.ok) return null;
  const data = await res.json();
  const authors = data?.data ?? [];
  if (authors.length === 0) return null;

  // Find the best match: name must match AND prefer the one with highest h-index
  // (common Chinese names like "Wei Zhang" may have many profiles)
  let best: S2AuthorInfo | null = null;

  for (const author of authors) {
    if (!namesMatch(authorName, author.name ?? "")) continue;
    const candidate: S2AuthorInfo = {
      authorId: author.authorId,
      hIndex: author.hIndex ?? null,
      citationCount: author.citationCount ?? null,
      paperCount: author.paperCount ?? null,
      affiliations: Array.isArray(author.affiliations)
        ? author.affiliations.map((s: unknown) => String(s)).filter(Boolean)
        : [],
    };
    // Pick the profile with the highest h-index (most likely the right person
    // for well-published researchers; for unknowns, any match is better than none)
    if (!best || (candidate.hIndex ?? 0) > (best.hIndex ?? 0)) {
      best = candidate;
    }
  }

  return best;
}

/**
 * Look up an author on Semantic Scholar and return their h-index and citation count.
 *
 * Uses two strategies:
 * 1. Search by paper title → find matching author (most precise)
 * 2. Search by author name directly (fallback for papers not yet indexed)
 *
 * Returns null if both strategies fail.
 */
export async function lookupAuthor(
  paperTitle: string,
  authorName: string,
): Promise<S2AuthorInfo | null> {
  try {
    // Strategy 1: paper-based lookup (most precise)
    const viaP = await lookupViaPaper(paperTitle, authorName);
    if (viaP) return viaP;

    // Strategy 2: direct author search (fallback for fresh papers)
    await sleep(S2_DELAY_MS);
    return await lookupViaAuthor(authorName);
  } catch {
    return null;
  }
}
