// Resolve email_contact_history.paper_title → paper_arxiv_id where possible.
// Pure SQL-side join via two passes:
//   pass 1: exact title match against pipeline_leads
//   pass 2: prefix match (first 60 chars) against pipeline_leads + papers
// Then re-runs the migration-036 outreach rollup so papers.last_outreach_at
// reflects the new history → arxiv_id links.

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

console.log("Building title → arxiv_id map from pipeline_leads + papers...");
const titleMap = new Map(); // lowercased trimmed title → arxiv_id

async function loadAll(table, fields) {
  let off = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await sb.from(table).select(fields).range(off, off + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) {
      if (r.title && r.arxiv_id) {
        const key = r.title.toLowerCase().trim();
        if (!titleMap.has(key)) titleMap.set(key, r.arxiv_id);
      }
    }
    off += data.length;
    if (data.length < PAGE) break;
  }
}
await loadAll("pipeline_leads", "arxiv_id, title");
await loadAll("papers", "arxiv_id, title");
console.log(`  ${titleMap.size} titles indexed`);

// Build a prefix index too (60 chars) for fuzzy matches
const prefixMap = new Map();
for (const [t, id] of titleMap) {
  const stem = t.slice(0, 60);
  if (stem.length >= 30 && !prefixMap.has(stem)) prefixMap.set(stem, id);
}

// Walk history rows that need an arxiv_id. Page through them.
console.log("\nWalking history rows missing arxiv_id...");
let processed = 0, exactHit = 0, prefixHit = 0, miss = 0;
const missSamples = [];
const updates = []; // {title, arxiv_id}
let off = 0;
const PAGE = 500;
while (true) {
  const { data, error } = await sb
    .from("email_contact_history")
    .select("email, paper_title, contacted_at")
    .is("paper_arxiv_id", null)
    .not("paper_title", "is", null)
    .range(off, off + PAGE - 1);
  if (error) {
    console.error("page failed:", error.message);
    break;
  }
  if (!data || data.length === 0) break;
  for (const r of data) {
    processed++;
    const key = (r.paper_title || "").toLowerCase().trim();
    let arxiv = titleMap.get(key);
    if (arxiv) {
      exactHit++;
      updates.push({ title: r.paper_title, arxiv_id: arxiv });
      continue;
    }
    // Try first-char glitch (some titles in source had a chopped initial char)
    arxiv = titleMap.get(key.slice(1));
    if (arxiv) {
      exactHit++;
      updates.push({ title: r.paper_title, arxiv_id: arxiv });
      continue;
    }
    // Prefix match
    const stem = key.slice(0, 60);
    arxiv = prefixMap.get(stem);
    if (arxiv) {
      prefixHit++;
      updates.push({ title: r.paper_title, arxiv_id: arxiv });
      continue;
    }
    miss++;
    if (missSamples.length < 5) missSamples.push(r.paper_title);
  }
  off += data.length;
  if (data.length < PAGE) break;
  process.stdout.write(`  scanned ${processed}, hits=${exactHit + prefixHit}, miss=${miss}\r`);
}
process.stdout.write("\n");

console.log(`\nMatched ${updates.length} rows. Applying updates by title...`);

// Dedupe updates by title to minimize round-trips
const uniqByTitle = new Map();
for (const u of updates) {
  if (!uniqByTitle.has(u.title)) uniqByTitle.set(u.title, u.arxiv_id);
}
console.log(`  ${uniqByTitle.size} unique titles to backfill`);

let applied = 0, fail = 0;
let i = 0;
for (const [title, arxiv_id] of uniqByTitle) {
  i++;
  const { error } = await sb
    .from("email_contact_history")
    .update({ paper_arxiv_id: arxiv_id })
    .ilike("paper_title", title)
    .is("paper_arxiv_id", null);
  if (error) {
    fail++;
    if (fail < 5) console.error(`  update fail for "${title.slice(0, 50)}": ${error.message}`);
  } else {
    applied++;
  }
  if (i % 50 === 0) process.stdout.write(`  ${i}/${uniqByTitle.size}\r`);
}
process.stdout.write("\n");

console.log(`\n=== Title resolution Summary ===`);
console.log(`Scanned: ${processed}`);
console.log(`Exact hit: ${exactHit}`);
console.log(`Prefix hit: ${prefixHit}`);
console.log(`Miss (paper not in pipeline_leads or papers): ${miss}`);
console.log(`Updates applied (unique titles): ${applied}`);
console.log(`Update failures: ${fail}`);
console.log(`\nMiss samples:`, missSamples);

// Coverage after
const { count: totalRows } = await sb.from("email_contact_history").select("*", { count: "exact", head: true });
const { count: nowWithArxiv } = await sb.from("email_contact_history").select("*", { count: "exact", head: true }).not("paper_arxiv_id", "is", null);
console.log(`\nemail_contact_history coverage: ${nowWithArxiv}/${totalRows} (${((nowWithArxiv / totalRows) * 100).toFixed(1)}%)`);
