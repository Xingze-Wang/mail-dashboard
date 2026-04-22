// Tavily search fallback for author citation count when Semantic Scholar misses.
//
// S2 covers most published researchers but misses (a) new PhDs with one paper,
// (b) industry researchers, (c) name collisions on very common Chinese names.
// Tavily is a web search API — we ask it to find a Google Scholar profile
// and extract the citation total from the search snippets.

const TAVILY_BASE = "https://api.tavily.com/search";

export interface TavilyCiteResult {
  citationCount: number | null;
  source: string;
}

function getKey(): string | null {
  return process.env.TAVILY_API_KEY || null;
}

function extractCitations(snippets: string[]): number | null {
  // Google Scholar snippets contain patterns like:
  //   "Cited by 12345"
  //   "引用次数 12345"
  //   "12,345 citations"
  // Pick the largest match; Scholar shows h-index and total-cite separately,
  // total is bigger so max wins.
  let best = 0;
  const patterns: RegExp[] = [
    /cited by\s+([\d,]+)/gi,
    /引用次数[：: ]*([\d,]+)/g,
    /被引用[：: ]*([\d,]+)/g,
    /([\d,]+)\s+citations?/gi,
  ];
  for (const text of snippets) {
    for (const re of patterns) {
      for (const m of text.matchAll(re)) {
        const n = parseInt(m[1].replace(/,/g, ""), 10);
        if (!isNaN(n) && n > best) best = n;
      }
    }
  }
  return best > 0 ? best : null;
}

export async function lookupCitationsViaTavily(
  authorName: string,
  authorEmail?: string | null,
): Promise<TavilyCiteResult | null> {
  const key = getKey();
  if (!key || !authorName) return null;

  // Prefer searches that point to Google Scholar or a personal page, since
  // raw paper hits don't give us author-level totals.
  const affiliation = authorEmail?.split("@").pop() ?? "";
  const query = `"${authorName}" ${affiliation} google scholar citations`;

  try {
    const res = await fetch(TAVILY_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        query,
        search_depth: "basic",
        max_results: 5,
        include_domains: ["scholar.google.com", "scholar.google.co.uk"],
      }),
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) {
      console.error(`Tavily API error: ${res.status}`);
      return null;
    }

    const data = (await res.json()) as {
      results?: { title?: string; content?: string; url?: string }[];
    };
    const snippets = (data.results ?? [])
      .map((r) => `${r.title ?? ""}\n${r.content ?? ""}`)
      .filter(Boolean);
    if (snippets.length === 0) return null;

    const count = extractCitations(snippets);
    if (count === null) return null;

    return { citationCount: count, source: data.results?.[0]?.url ?? "tavily" };
  } catch (err) {
    console.error("Tavily lookup failed", { authorName, err: String(err) });
    return null;
  }
}
