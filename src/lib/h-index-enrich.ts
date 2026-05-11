// Shared S2-driven h-index enrichment. Used by:
//   - /api/cron/enrich-h-index — nightly batch (50 leads/run)
//   - scripts/_enrich-h-index-burst.mjs — manual burst (no rate limit)
//
// Pipeline per lead:
//   1. If the lead already has h_index, skip (idempotent).
//   2. Look up the paper on Semantic Scholar by arxiv_id.
//   3. Find the matching author by name within the paper's author list.
//      (`bestAuthorMatch` handles Chinese surname-flip, accent-strip,
//      and partial token overlap so "Cao Hongyuze" matches "Hongyuze Cao".)
//   4. Pull h-index / citation / paper_count from that author's S2 record.
//   5. Write back to pipeline_leads, null-stripped so we never write 0
//      on a missed lookup (the shard-12 corruption pattern we already
//      cleaned up once).
//
// Rate-limit posture: S2's public API allows ~100 req/5min unauth'd;
// we deliberately stay well under that with a 1s sleep between calls.
// If you set SEMANTIC_SCHOLAR_API_KEY in env, the helper sends it and
// the limit jumps to 1000 req/sec — paste the free key from
// https://www.semanticscholar.org/product/api#api-key.

import { supabase } from "@/lib/db";

const S2_API = "https://api.semanticscholar.org/graph/v1";

function normalizeName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")     // strip diacritics
    .replace(/[^a-zA-Z一-鿿\s]/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): string[] {
  return normalizeName(s).split(/\s+/).filter(Boolean);
}

/** True if every token of `needle` appears somewhere in `hay`. Used to
 *  match "Hongyuze Cao" against an S2 author name like "Cao Hongyuze"
 *  or "H. Cao". Permissive but anchored to all-tokens-present. */
function nameMatch(needle: string, hay: string): boolean {
  const n = tokens(needle);
  const h = new Set(tokens(hay));
  if (n.length === 0) return false;
  return n.every((t) => {
    // exact token, or hay contains a token starting with this letter
    // (initials like "H." matching "Hongyuze")
    return h.has(t) || [...h].some((ht) => ht.startsWith(t) || t.startsWith(ht));
  });
}

interface S2Author {
  authorId: string | null;
  name: string;
  hIndex: number | null;
  citationCount: number | null;
  paperCount: number | null;
  affiliations: string[] | null;
}

interface EnrichResult {
  status: "wrote" | "no_paper" | "no_author_match" | "no_metrics" | "already_filled" | "err";
  details: string;
  h_index?: number | null;
  citation_count?: number | null;
  paper_count?: number | null;
  s2_author_id?: string | null;
}

const SLEEP_MS = 1100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function s2Headers(): HeadersInit {
  const h: HeadersInit = { "User-Agent": "qiji-pipeline-enrich/1.0" };
  if (process.env.SEMANTIC_SCHOLAR_API_KEY) {
    h["x-api-key"] = process.env.SEMANTIC_SCHOLAR_API_KEY;
  }
  return h;
}

/** Fetch a paper from S2 by arxiv id, including its full author list with
 *  per-author h-index / citation / paper count. One round trip. */
async function fetchPaperByArxiv(arxivId: string): Promise<{ authors: S2Author[] } | null> {
  const url = `${S2_API}/paper/arXiv:${arxivId}?fields=title,authors,authors.hIndex,authors.citationCount,authors.paperCount,authors.affiliations,authors.name`;
  try {
    const r = await fetch(url, { headers: s2Headers(), signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return null;
    const j = (await r.json().catch(() => null)) as {
      authors?: Array<{ authorId: string | null; name: string; hIndex?: number | null; citationCount?: number | null; paperCount?: number | null; affiliations?: string[] | null }>;
    } | null;
    if (!j || !Array.isArray(j.authors)) return null;
    return {
      authors: j.authors.map((a) => ({
        authorId: a.authorId ?? null,
        name: a.name,
        hIndex: a.hIndex ?? null,
        citationCount: a.citationCount ?? null,
        paperCount: a.paperCount ?? null,
        affiliations: Array.isArray(a.affiliations) ? a.affiliations : null,
      })),
    };
  } catch {
    return null;
  }
}

/** Score how confident we are that an S2 author matches the lead's name.
 *  Returns the highest-scoring author, or null if nothing scores positive. */
function bestAuthorMatch(needle: string, authors: S2Author[]): S2Author | null {
  let best: { a: S2Author; score: number } | null = null;
  const needleToks = tokens(needle);
  for (const a of authors) {
    if (!a.name) continue;
    const matched = nameMatch(needle, a.name);
    if (!matched) continue;
    // Score by token overlap so "Hongyuze Cao" beats "H. Cao" on rich matches.
    const hayToks = new Set(tokens(a.name));
    const overlap = needleToks.filter((t) => hayToks.has(t)).length;
    if (!best || overlap > best.score) best = { a, score: overlap };
  }
  return best?.a ?? null;
}

/** Enrich one lead. Returns the status + the updated values (when
 *  applicable) so the caller can log / aggregate. */
export async function enrichLead(lead: {
  id: string;
  arxiv_id: string | null;
  author_name: string | null;
  first_name: string | null;
  h_index: number | null;
}): Promise<EnrichResult> {
  if (lead.h_index != null) {
    return { status: "already_filled", details: "h_index already set" };
  }
  if (!lead.arxiv_id) {
    return { status: "no_paper", details: "no arxiv_id" };
  }
  const name = lead.author_name || lead.first_name;
  if (!name || name.length < 2) {
    return { status: "no_paper", details: "no usable author_name" };
  }

  const paper = await fetchPaperByArxiv(lead.arxiv_id);
  await sleep(SLEEP_MS);
  if (!paper) return { status: "no_paper", details: `S2 had no record for arXiv:${lead.arxiv_id}` };

  const author = bestAuthorMatch(name, paper.authors);
  if (!author) {
    return {
      status: "no_author_match",
      details: `name "${name}" didn't match any of: ${paper.authors.map((x) => x.name).join(", ").slice(0, 200)}`,
    };
  }

  if (author.hIndex == null && author.citationCount == null) {
    return { status: "no_metrics", details: `S2 has no h/c for ${author.name}` };
  }
  // Treat (h=0, c=0) the same as "no metrics" — S2 has the author
  // record but hasn't aggregated any citations to them yet. Writing
  // 0 corrupts downstream bucketing (h<5 inflates, the author shows
  // as "no citations" on /pipeline) and prevents future re-enrichment
  // because the cron skips any non-null h_index. Better to keep null
  // and try again next cycle when S2 has more data.
  if ((author.hIndex ?? 0) === 0 && (author.citationCount ?? 0) === 0) {
    return { status: "no_metrics", details: `S2 has zero metrics for ${author.name} (new author, defer)` };
  }

  // Build the update payload, dropping nulls so we never write 0 over
  // existing data nor blank out school by mistake. The lead-row write
  // is the only place we ever touch these fields.
  const upd: Record<string, unknown> = {};
  if (author.hIndex != null) upd.h_index = author.hIndex;
  if (author.citationCount != null) upd.citation_count = author.citationCount;
  if (author.paperCount != null) upd.paper_count = author.paperCount;
  if (author.authorId) upd.s2_author_id = author.authorId;

  const { error } = await supabase.from("pipeline_leads").update(upd).eq("id", lead.id);
  if (error) return { status: "err", details: error.message };

  return {
    status: "wrote",
    details: `${author.name} → h=${author.hIndex ?? "?"} c=${author.citationCount ?? "?"} p=${author.paperCount ?? "?"}`,
    h_index: author.hIndex,
    citation_count: author.citationCount,
    paper_count: author.paperCount,
    s2_author_id: author.authorId,
  };
}

/** Pull the next batch of leads needing enrichment. Newest first so a
 *  daily cron prioritises today's scan output before catching up on
 *  the long tail. */
export async function fetchEnrichmentBatch(limit: number): Promise<Array<{
  id: string;
  arxiv_id: string | null;
  author_name: string | null;
  first_name: string | null;
  h_index: number | null;
}>> {
  const { data, error } = await supabase
    .from("pipeline_leads")
    .select("id, arxiv_id, author_name, first_name, h_index, created_at")
    .is("h_index", null)
    .not("arxiv_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return [];
  return (data ?? []).map((d) => ({
    id: d.id as string,
    arxiv_id: d.arxiv_id as string | null,
    author_name: d.author_name as string | null,
    first_name: d.first_name as string | null,
    h_index: d.h_index as number | null,
  }));
}
