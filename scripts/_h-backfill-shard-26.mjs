// Process shard-26: confirm author from paper via S2, write h-index + citation_count + paper_count.
// Also null-fill school_name from S2 author affiliations when lead.school_name is null.
//
// Disambiguation = author name + paper title.
// Strategy: try /paper/arxiv:{id} first. If 404 (synthetic/future arxiv id),
// fall back to /paper/search?query=<title>, then pick the first result whose
// normalized title is a strong overlap with the lead's title.

import { createClient } from "@supabase/supabase-js";
import fs from "fs";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const S2_BASE = "https://api.semanticscholar.org/graph/v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const leads = JSON.parse(fs.readFileSync("/tmp/h-backfill-v2/shard-26.json", "utf8"));

function norm(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s) {
  return new Set(norm(s).split(" ").filter(Boolean));
}

function titleOverlap(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  return hit / Math.max(ta.size, tb.size);
}

function pickAuthor(namedRaw, authors) {
  if (!authors || authors.length === 0) return { match: null, reason: "no_authors_from_s2" };
  const first = (namedRaw || "").split(",")[0].trim();
  const nTokens = tokens(first);
  if (nTokens.size === 0) return { match: null, reason: "empty_name" };

  for (const a of authors) {
    if (norm(a.name) === norm(first)) return { match: a, reason: "exact_norm" };
  }
  let best = null;
  let bestScore = 0;
  for (const a of authors) {
    const aTokens = tokens(a.name);
    let hit = 0;
    for (const t of nTokens) if (aTokens.has(t)) hit++;
    const score = hit / nTokens.size;
    if (score > bestScore) {
      bestScore = score;
      best = a;
    }
  }
  if (bestScore >= 1) return { match: best, reason: "subset" };
  if (bestScore >= 0.5) return { match: best, reason: `partial(${bestScore.toFixed(2)})` };
  return { match: null, reason: `no_match(best=${bestScore.toFixed(2)})` };
}

async function s2Fetch(url, label) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (res.status === 429) {
        await sleep(3000 * attempt);
        continue;
      }
      if (res.status === 404) {
        return { ok: false, status: 404, body: null };
      }
      if (!res.ok) {
        return { ok: false, status: res.status, body: null };
      }
      const body = await res.json();
      return { ok: true, status: 200, body };
    } catch (e) {
      await sleep(2000 * attempt);
    }
  }
  return { ok: false, status: 0, body: null };
}

const FIELDS = "title,authors.name,authors.authorId,authors.hIndex,authors.citationCount,authors.paperCount,authors.affiliations";

const results = [];
for (const lead of leads) {
  const row = {
    id: lead.id,
    name: lead.name,
    school_in: lead.school,
    arxiv_id: lead.arxiv_id,
    paper_title: lead.paper_title,
    matched: null,
    h_index: null,
    citation_count: null,
    paper_count: null,
    school_name_from_s2: null,
    s2_author_id: null,
    paper_title_s2: null,
    paper_source: null,
    reason: "",
    update: "skip",
  };

  // Step 1a: try /paper/arxiv:{id}
  let paper = null;
  const byArxiv = await s2Fetch(`${S2_BASE}/paper/arxiv:${lead.arxiv_id}?fields=${FIELDS}`, "by_arxiv");
  if (byArxiv.ok) {
    paper = byArxiv.body;
    row.paper_source = "arxiv_id";
  } else if (byArxiv.status === 404) {
    // Step 1b: search by title
    await sleep(1500);
    const q = encodeURIComponent(lead.paper_title || "");
    const search = await s2Fetch(`${S2_BASE}/paper/search?query=${q}&limit=5&fields=${FIELDS}`, "by_title");
    if (search.ok && search.body?.data?.length) {
      const candidates = search.body.data;
      let best = null;
      let bestScore = 0;
      for (const c of candidates) {
        const s = titleOverlap(lead.paper_title, c.title);
        if (s > bestScore) {
          bestScore = s;
          best = c;
        }
      }
      if (best && bestScore >= 0.6) {
        paper = best;
        row.paper_source = `title_search(${bestScore.toFixed(2)})`;
      } else {
        row.reason = `title_search_low_overlap(best=${bestScore.toFixed(2)})`;
      }
    } else {
      row.reason = `title_search_empty(http=${search.status})`;
    }
  } else {
    row.reason = `s2_paper_http_${byArxiv.status}`;
  }

  if (!paper) {
    results.push(row);
    console.log(JSON.stringify({ id: lead.id.slice(0, 8), name: lead.name, status: "FAIL_PAPER", reason: row.reason }));
    await sleep(2000);
    continue;
  }

  row.paper_title_s2 = paper.title || null;

  const { match, reason } = pickAuthor(lead.name, paper.authors);
  row.reason = reason;

  if (!match) {
    results.push(row);
    console.log(JSON.stringify({
      id: lead.id.slice(0, 8),
      name: lead.name,
      status: "NO_MATCH",
      reason,
      paper_title_s2: row.paper_title_s2,
      authors_on_paper: (paper.authors || []).map((a) => a.name),
    }));
    await sleep(2000);
    continue;
  }

  row.matched = match.name;
  row.h_index = match.hIndex ?? null;
  row.citation_count = match.citationCount ?? null;
  row.paper_count = match.paperCount ?? null;
  // affiliations is a list of strings on S2
  if (Array.isArray(match.affiliations) && match.affiliations.length > 0) {
    row.school_name_from_s2 = match.affiliations[0];
  }
  row.s2_author_id = match.authorId ?? null;

  // Step 3: build patch
  const patch = {};
  if (row.h_index != null) patch.h_index = row.h_index;
  if (row.citation_count != null) patch.citation_count = row.citation_count;
  if (row.paper_count != null) patch.paper_count = row.paper_count;
  // null-fill school_name only
  if ((lead.school == null || lead.school === "") && row.school_name_from_s2) {
    patch.school_name = row.school_name_from_s2;
  }

  if (Object.keys(patch).length === 0) {
    row.update = "skip_null";
  } else {
    const { error } = await sb.from("pipeline_leads").update(patch).eq("id", lead.id);
    if (error) {
      row.update = `error:${error.message}`;
    } else {
      row.update = `ok(${Object.keys(patch).join(",")})`;
    }
  }

  results.push(row);
  console.log(JSON.stringify({
    id: lead.id.slice(0, 8),
    name: lead.name,
    matched: row.matched,
    h: row.h_index,
    cites: row.citation_count,
    pc: row.paper_count,
    school_fill: patch.school_name || null,
    src: row.paper_source,
    reason: row.reason,
    update: row.update,
  }));

  await sleep(2000);
}

fs.writeFileSync("/tmp/h-backfill-v2/shard-26-results.json", JSON.stringify(results, null, 2));

const ok = results.filter((r) => r.update.startsWith("ok")).length;
const skip = results.filter((r) => r.update.startsWith("skip")).length;
const err = results.filter((r) => r.update.startsWith("error")).length;
const noMatch = results.filter((r) => !r.matched).length;
console.log("---");
console.log(JSON.stringify({ total: results.length, written: ok, skipped: skip, errors: err, no_match: noMatch }));
