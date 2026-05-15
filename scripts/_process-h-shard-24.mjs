// Process shard-24: confirm author via paper-title disambig, write h_index,
// citation_count, paper_count, and school_name (null-fill only).

import { createClient } from "@supabase/supabase-js";
import fs from "fs";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const S2_BASE = "https://api.semanticscholar.org/graph/v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const leads = JSON.parse(fs.readFileSync("/tmp/h-backfill-v2/shard-24.json", "utf8"));

function norm(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s) {
  return new Set(norm(s).split(" ").filter(Boolean));
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
        await sleep(4000 * attempt);
        continue;
      }
      if (!res.ok) {
        return { ok: false, reason: `${label}_http_${res.status}` };
      }
      return { ok: true, json: await res.json() };
    } catch (e) {
      await sleep(2500);
      if (attempt === 6) return { ok: false, reason: `${label}_err:${e.message}` };
    }
  }
  return { ok: false, reason: `${label}_retries_exhausted` };
}

const results = [];
for (const lead of leads) {
  const row = {
    id: lead.id,
    name: lead.name,
    arxiv_id: lead.arxiv_id,
    paper_title: lead.paper_title,
    school_input: lead.school,
    matched: null,
    h_index: null,
    citation_count: null,
    paper_count: null,
    school_name_proposed: null,
    s2_author_id: null,
    paper_title_s2: null,
    reason: "",
    update: "skip",
  };

  // Step 1: paper → authors
  const paperRes = await s2Fetch(
    `${S2_BASE}/paper/arxiv:${lead.arxiv_id}?fields=title,authors.name,authors.authorId,authors.hIndex,authors.citationCount,authors.paperCount,authors.affiliations`,
    "s2_paper",
  );
  await sleep(1800);
  if (!paperRes.ok) {
    row.reason = paperRes.reason;
    results.push(row);
    console.log(JSON.stringify({ id: lead.id.slice(0, 8), name: lead.name, status: "FAIL_PAPER", reason: row.reason }));
    continue;
  }
  const paper = paperRes.json;
  row.paper_title_s2 = paper.title || null;

  // Step 2: author match
  const { match, reason } = pickAuthor(lead.name, paper.authors);
  row.reason = reason;
  if (!match) {
    results.push(row);
    console.log(JSON.stringify({
      id: lead.id.slice(0, 8),
      name: lead.name,
      status: "NO_MATCH",
      reason,
      authors_on_paper: (paper.authors || []).map((a) => a.name),
    }));
    continue;
  }
  row.matched = match.name;
  row.h_index = match.hIndex ?? null;
  row.citation_count = match.citationCount ?? null;
  row.paper_count = match.paperCount ?? null;
  row.s2_author_id = match.authorId ?? null;

  // Affiliations from paper-side author object
  const affs = Array.isArray(match.affiliations) ? match.affiliations.filter(Boolean) : [];
  if (affs.length > 0) row.school_name_proposed = affs[0];

  // Step 3: write — only fill school_name if it was null
  const patch = {};
  if (row.h_index != null) patch.h_index = row.h_index;
  if (row.citation_count != null) patch.citation_count = row.citation_count;
  if (row.paper_count != null) patch.paper_count = row.paper_count;
  if (!lead.school && row.school_name_proposed) patch.school_name = row.school_name_proposed;

  if (Object.keys(patch).length === 0) {
    row.update = "skip_null";
  } else {
    const { error } = await sb.from("pipeline_leads").update(patch).eq("id", lead.id);
    if (error) {
      row.update = `error:${error.message}`;
    } else {
      row.update = `ok:${Object.keys(patch).join(",")}`;
    }
  }

  results.push(row);
  console.log(JSON.stringify({
    id: lead.id.slice(0, 8),
    name: lead.name,
    matched: row.matched,
    h: row.h_index,
    cites: row.citation_count,
    papers: row.paper_count,
    school: row.school_name_proposed,
    reason: row.reason,
    update: row.update,
  }));
}

fs.writeFileSync("/tmp/h-backfill-v2/shard-24-results.json", JSON.stringify(results, null, 2));

const ok = results.filter((r) => r.update.startsWith("ok")).length;
const skip = results.filter((r) => r.update.startsWith("skip")).length;
const err = results.filter((r) => r.update.startsWith("error")).length;
const noMatch = results.filter((r) => !r.matched).length;
console.log("---");
console.log(JSON.stringify({ total: results.length, written: ok, skipped: skip, errors: err, no_match: noMatch }));
