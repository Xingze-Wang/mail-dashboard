// Process shard-29: confirm author from paper via S2, write h_index, citation_count,
// paper_count, school_name (null-fill only). Disambiguation = paper-title via arxiv id.

import { createClient } from "@supabase/supabase-js";
import fs from "fs";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const S2_BASE = "https://api.semanticscholar.org/graph/v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const leads = JSON.parse(fs.readFileSync("/tmp/h-backfill-v2/shard-29.json", "utf8"));

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

async function fetchPaper(arxivId) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const url = `${S2_BASE}/paper/arxiv:${arxivId}?fields=title,authors.name,authors.authorId,authors.hIndex,authors.citationCount,authors.paperCount,authors.affiliations`;
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (res.status === 429) {
        await sleep(5000 * attempt);
        continue;
      }
      if (res.status === 404) return { _err: "s2_paper_404" };
      if (!res.ok) return { _err: `s2_paper_http_${res.status}` };
      return await res.json();
    } catch (e) {
      if (attempt >= 6) return { _err: `s2_paper_err:${e.message}` };
      await sleep(2000 * attempt);
    }
  }
  return { _err: "s2_paper_unreached" };
}

const results = [];
for (const lead of leads) {
  const row = {
    id: lead.id,
    name: lead.name,
    school_lead: lead.school,
    arxiv_id: lead.arxiv_id,
    paper_title: lead.paper_title,
    matched: null,
    h_index: null,
    citation_count: null,
    paper_count: null,
    s2_author_id: null,
    s2_affiliations: null,
    paper_title_s2: null,
    reason: "",
    update: "skip",
  };

  const paper = await fetchPaper(lead.arxiv_id);
  if (paper._err) {
    row.reason = paper._err;
    results.push(row);
    console.log(JSON.stringify({ id: lead.id.slice(0, 8), name: lead.name, status: "FAIL_PAPER", reason: row.reason }));
    await sleep(1800);
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
      authors_on_paper: (paper.authors || []).map((a) => a.name),
    }));
    await sleep(1800);
    continue;
  }

  row.matched = match.name;
  row.h_index = match.hIndex ?? null;
  row.citation_count = match.citationCount ?? null;
  row.paper_count = match.paperCount ?? null;
  row.s2_author_id = match.authorId ?? null;
  row.s2_affiliations = match.affiliations || null;

  // current row to decide null-fill on school_name
  const { data: existing, error: readErr } = await sb
    .from("pipeline_leads")
    .select("school_name")
    .eq("id", lead.id)
    .maybeSingle();
  if (readErr) {
    row.update = `read_err:${readErr.message}`;
    results.push(row);
    console.log(JSON.stringify({ id: lead.id.slice(0, 8), name: lead.name, update: row.update }));
    await sleep(1800);
    continue;
  }

  const patch = {};
  if (row.h_index != null) patch.h_index = row.h_index;
  if (row.citation_count != null) patch.citation_count = row.citation_count;
  if (row.paper_count != null) patch.paper_count = row.paper_count;
  if (
    (existing?.school_name == null || existing.school_name === "") &&
    Array.isArray(row.s2_affiliations) &&
    row.s2_affiliations.length > 0
  ) {
    patch.school_name = row.s2_affiliations[0];
  }

  if (Object.keys(patch).length === 0) {
    row.update = "skip_null";
  } else {
    const { error } = await sb.from("pipeline_leads").update(patch).eq("id", lead.id);
    row.update = error ? `error:${error.message}` : "ok";
    row.patch = patch;
  }

  results.push(row);
  console.log(JSON.stringify({
    id: lead.id.slice(0, 8),
    name: lead.name,
    matched: row.matched,
    h: row.h_index,
    cites: row.citation_count,
    papers: row.paper_count,
    school_filled: patch.school_name || null,
    reason: row.reason,
    update: row.update,
  }));

  await sleep(1800);
}

fs.writeFileSync("/tmp/h-backfill-v2/shard-29-results.json", JSON.stringify(results, null, 2));

const ok = results.filter((r) => r.update === "ok").length;
const skip = results.filter((r) => r.update.startsWith("skip")).length;
const err = results.filter((r) => r.update.startsWith("error") || r.update.startsWith("read_err")).length;
const noMatch = results.filter((r) => !r.matched).length;
console.log("---");
console.log(JSON.stringify({ total: results.length, written: ok, skipped: skip, errors: err, no_match: noMatch }));
