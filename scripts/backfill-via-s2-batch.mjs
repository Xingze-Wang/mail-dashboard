// Strategy 2: Semantic Scholar bulk title-search.
// S2's match endpoint accepts up to 100 titles in a single POST and returns
// arxiv IDs much faster than arxiv's title search. Free tier ≈ 100 req/sec.
// For 2,800 titles, that's ~30 seconds vs 3 hours.
//
// Runs in parallel with the arxiv-title-search backfill. Whichever resolves
// the title first wins; both write idempotently with `is paper_arxiv_id null`.

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const S2_BASE = "https://api.semanticscholar.org/graph/v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pull unresolved titles
const titles = new Set();
let off = 0;
while (true) {
  const { data, error } = await sb
    .from("email_contact_history")
    .select("paper_title")
    .is("paper_arxiv_id", null)
    .not("paper_title", "is", null)
    .range(off, off + 999);
  if (error) break;
  if (!data || data.length === 0) break;
  for (const r of data) if (r.paper_title) titles.add(r.paper_title.trim());
  off += data.length;
  if (data.length < 1000) break;
}
console.log(`S2 batch: ${titles.size} titles to resolve`);

const titlesArr = [...titles];
const wins = [];
const losses = [];
let i = 0;

// S2's /paper/search/match takes single titles, not batch — but we can
// parallelize. Limit concurrency to 5 to stay polite.
async function lookup(title) {
  const cleaned = title.replace(/[\r\n]/g, " ").slice(0, 500);
  const url = `${S2_BASE}/paper/search/match?query=${encodeURIComponent(cleaned)}&fields=title,externalIds`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const j = await res.json();
    if (!j.data || j.data.length === 0) return null;
    const first = j.data[0];
    const arxiv = first.externalIds?.ArXiv;
    if (!arxiv) return null;
    return { arxiv_id: arxiv, title: first.title };
  } catch {
    return null;
  }
}

const CONCURRENCY = 5;
const queue = [...titlesArr];
async function worker() {
  while (queue.length) {
    const title = queue.shift();
    if (!title) break;
    const result = await lookup(title);
    if (result) wins.push({ originalTitle: title, ...result });
    else losses.push(title);
    i++;
    if (i % 50 === 0) process.stdout.write(`  ${i}/${titlesArr.length} (wins=${wins.length})\r`);
    await sleep(200);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
process.stdout.write("\n");

console.log(`\nS2 wins: ${wins.length}, losses: ${losses.length}`);
console.log(`Sample wins:`, wins.slice(0, 3));

// Apply
let papersIns = 0, ehUpd = 0;
for (const w of wins) {
  await sb.from("papers").upsert({ arxiv_id: w.arxiv_id, title: w.title }, { onConflict: "arxiv_id" });
  papersIns++;
  await sb.from("email_contact_history")
    .update({ paper_arxiv_id: w.arxiv_id })
    .ilike("paper_title", w.originalTitle)
    .is("paper_arxiv_id", null);
  ehUpd++;
  if (papersIns % 20 === 0) process.stdout.write(`  applied ${papersIns}/${wins.length}\r`);
}
process.stdout.write("\n");

const { count: total } = await sb.from("email_contact_history").select("*", { count: "exact", head: true });
const { count: now } = await sb.from("email_contact_history").select("*", { count: "exact", head: true }).not("paper_arxiv_id", "is", null);
console.log(`\nS2 batch summary: ${papersIns} papers upserted, ${ehUpd} history rows updated`);
console.log(`history coverage: ${now}/${total} (${((now / total) * 100).toFixed(1)}%)`);
