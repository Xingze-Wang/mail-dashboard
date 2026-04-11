// Semantic Scholar API client for author h-index/citation lookup

const S2_BASE = "https://api.semanticscholar.org/graph/v1";
const S2_DELAY_MS = 1100; // stay under 1 req/sec

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface S2AuthorInfo {
  authorId: string;
  hIndex: number | null;
  citationCount: number | null;
  paperCount: number | null;
}

/**
 * Look up a paper on Semantic Scholar by title, then find the matching
 * author and return their h-index and citation count.
 *
 * Returns null if paper not found, author not matched, or API error.
 */
export async function lookupAuthor(
  paperTitle: string,
  authorName: string,
): Promise<S2AuthorInfo | null> {
  try {
    // Step 1: search for the paper by title
    const query = encodeURIComponent(paperTitle.slice(0, 200));
    const paperRes = await fetch(
      `${S2_BASE}/paper/search?query=${query}&limit=3&fields=title,authors`,
      { signal: AbortSignal.timeout(10_000) },
    );

    if (!paperRes.ok) return null;
    const paperData = await paperRes.json();
    const papers = paperData?.data ?? [];
    if (papers.length === 0) return null;

    // Step 2: find matching author across results
    const normalizedTarget = authorName.toLowerCase().replace(/\s+/g, " ").trim();
    let matchedAuthorId: string | null = null;

    for (const paper of papers) {
      for (const author of paper.authors ?? []) {
        const normalizedAuthor = (author.name ?? "").toLowerCase().replace(/\s+/g, " ").trim();
        // Check if all parts of target name appear in author name (handles name order)
        const targetParts = normalizedTarget.split(" ");
        const authorParts = normalizedAuthor.split(" ");
        const allPartsMatch = targetParts.every((p: string) =>
          authorParts.some((a: string) => a === p),
        );
        if (allPartsMatch && author.authorId) {
          matchedAuthorId = author.authorId;
          break;
        }
      }
      if (matchedAuthorId) break;
    }

    if (!matchedAuthorId) return null;

    // Step 3: fetch author details
    await sleep(S2_DELAY_MS);
    const authorRes = await fetch(
      `${S2_BASE}/author/${matchedAuthorId}?fields=hIndex,citationCount,paperCount`,
      { signal: AbortSignal.timeout(10_000) },
    );

    if (!authorRes.ok) return null;
    const authorData = await authorRes.json();

    return {
      authorId: matchedAuthorId,
      hIndex: authorData.hIndex ?? null,
      citationCount: authorData.citationCount ?? null,
      paperCount: authorData.paperCount ?? null,
    };
  } catch {
    return null;
  }
}
