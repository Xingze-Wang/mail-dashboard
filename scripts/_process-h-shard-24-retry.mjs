// Retry the 7 FAIL_PAPER leads from shard-24 with longer backoff.

import { createClient } from "@supabase/supabase-js";
import fs from "fs";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const S2_BASE = "https://api.semanticscholar.org/graph/v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hard-coded set of leads to retry (the 7 that failed in pass 1).
const RETRY_IDS = new Set([
  "7a273ccd-a41c-4881-8514-7f7ecac705ff", // Weijie Wang
  "417afac7-a341-497f-a088-ff3da100c51c", // Weicai Li
  "914b185f-bef1-4dd1-acac-f48b9a598083", // Faqiang Wang
  "6579298e-5ef9-4be2-bda7-ef13f7e3881c", // Xinyi Duan
  "71b97ea0-fe09-4073-82a5-3b9a5ff19fb2", // Ruibin Min
  "3b9fd772-c685-4179-8f53-3e6f36665e74", // Ying Zhang
  "65c77034-b440-4b68-aedc-13377a2e064a", // Xiwen Chen
]);

const allLeads = JSON.parse(fs.readFileSync("/tmp/h-backfill-v2/shard-24.json", "utf8"));
const leads = allLeads.filter((l) => RETRY_IDS.has(l.id));

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
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (res.status === 429) {
        await sleep(6000 * attempt);
        continue;
      }
      if (!res.ok) {
        return { ok: false, reason: `${label}_http_${res.status}` };
      }
      return { ok: true, json: await res.json() };
    } catch (e) {
      await sleep(3500);
      if (attempt === 8) return { ok: false, reason: `${label}_err:${e.message}` };
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

  const paperRes = await s2Fetch(
    `${S2_BASE}/paper/arxiv:${lead.arxiv_id}?fields=title,authors.name,authors.authorId,authors.hIndex,authors.citationCount,authors.paperCount,authors.affiliations`,
    "s2_paper",
  );
  await sleep(3000);
  if (!paperRes.ok) {
    row.reason = paperRes.reason;
    results.push(row);
    console.log(JSON.stringify({ id: lead.id.slice(0, 8), name: lead.name, status: "FAIL_PAPER", reason: row.reason }));
    continue;
  }
  const paper = paperRes.json;
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
    continue;
  }
  row.matched = match.name;
  row.h_index = match.hIndex ?? null;
  row.citation_count = match.citationCount ?? null;
  row.paper_count = match.paperCount ?? null;
  row.s2_author_id = match.authorId ?? null;

  const affs = Array.isArray(match.affiliations) ? match.affiliations.filter(Boolean) : [];
  if (affs.length > 0) row.school_name_proposed = affs[0];

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

fs.writeFileSync("/tmp/h-backfill-v2/shard-24-retry-results.json", JSON.stringify(results, null, 2));

const ok = results.filter((r) => r.update.startsWith("ok")).length;
const skip = results.filter((r) => r.update.startsWith("skip")).length;
const err = results.filter((r) => r.update.startsWith("error")).length;
const noMatch = results.filter((r) => !r.matched).length;
console.log("---");
console.log(JSON.stringify({ total: results.length, written: ok, skipped: skip, errors: err, no_match: noMatch }));
