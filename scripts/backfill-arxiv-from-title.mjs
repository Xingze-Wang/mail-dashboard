// For email_contact_history rows still missing paper_arxiv_id, search the
// arxiv API by title. arxiv's search endpoint accepts ti:"..." queries and
// returns the top match. Most of the 2,900 unresolved historical titles
// are real papers we never indexed in pipeline_leads — this fills them in.
//
// Rate limit: arxiv API allows ~1 request per 3 seconds. We pace at 4s.
// For 2,900 unique titles, that's ~3.2 hours. Idempotent: only touches
// rows where paper_arxiv_id IS NULL.
//
// As we resolve, we also write a paper row to `papers` so future scans
// share the lookup.

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const ARXIV_DELAY_MS = 4000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pull the unique unresolved titles
const titles = new Set();
let off = 0;
while (true) {
  const { data, error } = await sb
    .from("email_contact_history")
    .select("paper_title")
    .is("paper_arxiv_id", null)
    .not("paper_title", "is", null)
    .range(off, off + 999);
  if (error) {
    console.error("page fail:", error.message);
    break;
  }
  if (!data || data.length === 0) break;
  for (const r of data) {
    if (r.paper_title) titles.add(r.paper_title.trim());
  }
  off += data.length;
  if (data.length < 1000) break;
}
console.log(`Unique unresolved titles: ${titles.size}`);

// Search arxiv for each
const out = []; // { title, arxiv_id, published_at } — winners
const losers = []; // titles not found
let i = 0;
const titlesArr = [...titles];
for (const title of titlesArr) {
  i++;
  const cleaned = title.replace(/[^\w\s-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!cleaned) {
    losers.push(title);
    continue;
  }
  // arxiv "ti:" prefix searches title field; quote the phrase for exactness
  const url = `http://export.arxiv.org/api/query?search_query=ti:%22${encodeURIComponent(cleaned)}%22&max_results=3`;
  let xml = null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`http ${res.status}`);
    xml = await res.text();
  } catch (e) {
    losers.push(title);
    if (losers.length < 5) console.error(`  fetch fail "${title.slice(0, 40)}": ${e.message}`);
    await sleep(ARXIV_DELAY_MS);
    continue;
  }

  // Parse the first <entry>'s id + title
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]);
  let matched = null;
  for (const entry of entries) {
    const idMatch = entry.match(/<id>([^<]+)<\/id>/);
    const tMatch = entry.match(/<title>([\s\S]*?)<\/title>/);
    const pubMatch = entry.match(/<published>([^<]+)<\/published>/);
    if (!idMatch || !tMatch) continue;
    const arxivUrl = idMatch[1].trim();
    const arxivTitle = tMatch[1].trim().replace(/\s+/g, " ");
    // arxivUrl looks like "http://arxiv.org/abs/2401.12345v1" — extract id
    const idM = arxivUrl.match(/abs\/([0-9]{4}\.[0-9]{4,5})(v\d+)?/);
    if (!idM) continue;
    // Sanity check: title overlap (ignoring case + punctuation)
    const norm = (s) => s.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
    const overlap = norm(arxivTitle).slice(0, 60) === norm(cleaned).slice(0, 60);
    if (overlap) {
      matched = { arxiv_id: idM[1], title: arxivTitle, published_at: pubMatch?.[1] ?? null };
      break;
    }
  }
  if (matched) {
    out.push({ originalTitle: title, ...matched });
  } else {
    losers.push(title);
  }

  if (i % 10 === 0) {
    process.stdout.write(`  ${i}/${titlesArr.length} (matched=${out.length}, missed=${losers.length})\r`);
  }
  await sleep(ARXIV_DELAY_MS);
}
process.stdout.write("\n");
console.log(`\nMatched: ${out.length} / ${titlesArr.length}`);
console.log(`Sample wins:`, out.slice(0, 3));
console.log(`Sample misses:`, losers.slice(0, 5));

// Apply: upsert to papers, then update email_contact_history rows by title.
console.log("\nWriting to papers + email_contact_history...");
let papersIns = 0, ehUpd = 0, fail = 0;
for (const w of out) {
  // Upsert paper row
  const { error: pErr } = await sb.from("papers").upsert({
    arxiv_id: w.arxiv_id,
    title: w.title,
    published_at: w.published_at,
  }, { onConflict: "arxiv_id" });
  if (!pErr) papersIns++;
  else if (++fail < 5) console.error(`  papers upsert "${w.arxiv_id}": ${pErr.message}`);

  // Update history
  const { error: eErr } = await sb
    .from("email_contact_history")
    .update({ paper_arxiv_id: w.arxiv_id })
    .ilike("paper_title", w.originalTitle)
    .is("paper_arxiv_id", null);
  if (!eErr) ehUpd++;
}
console.log(`Papers upserted: ${papersIns}`);
console.log(`history rows updated: ${ehUpd}`);

// Final coverage
const { count: total } = await sb.from("email_contact_history").select("*", { count: "exact", head: true });
const { count: now } = await sb.from("email_contact_history").select("*", { count: "exact", head: true }).not("paper_arxiv_id", "is", null);
console.log(`\nemail_contact_history coverage: ${now}/${total} (${((now / total) * 100).toFixed(1)}%)`);
