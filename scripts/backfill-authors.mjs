// Backfill pipeline_leads.authors using the arxiv API for rows where
// authors looks like a single name (no comma) AND arxiv_id is set.
// Limit: 50 rows. Sleep 3s between arxiv calls (strict rate limit).

import { createClient } from "@supabase/supabase-js";

const url = "https://erguqrisqtugfysofwdd.supabase.co";
const key = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM";
const sb = createClient(url, key);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Decode common XML entities found in arxiv author names.
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

// Parse <author><name>...</name></author> entries from atom XML.
function parseAuthors(xml) {
  const authors = [];
  const re = /<author>\s*<name>([\s\S]*?)<\/name>\s*<\/author>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const name = decodeEntities(m[1]).replace(/\s+/g, " ").trim();
    if (name) authors.push(name);
  }
  return authors;
}

const t0 = Date.now();

console.log("=== Loading candidate rows ===");
const { data: rows, error } = await sb
  .from("pipeline_leads")
  .select("id, arxiv_id, authors")
  .not("arxiv_id", "is", null)
  .order("id", { ascending: true });

if (error) {
  console.error("query failed:", error);
  process.exit(1);
}

const candidates = (rows ?? []).filter((r) => {
  if (!r.arxiv_id) return false;
  if (r.authors == null) return true;
  return !String(r.authors).includes(",");
});

console.log(`  total with arxiv_id: ${rows.length}`);
console.log(`  candidates (single-name or null authors): ${candidates.length}`);

const target = candidates.slice(0, 50);
console.log(`  processing first ${target.length}`);

let updated = 0;
let unchanged = 0;
let failed = 0;
const samples = [];

for (let i = 0; i < target.length; i++) {
  const row = target[i];
  const before = row.authors;
  try {
    const apiUrl = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(row.arxiv_id)}`;
    const res = await fetch(apiUrl, { headers: { "User-Agent": "mail-backfill/1.0" } });
    if (!res.ok) {
      failed++;
      console.warn(`  [${i + 1}/${target.length}] arxiv ${row.arxiv_id} HTTP ${res.status}`);
    } else {
      const xml = await res.text();
      const authors = parseAuthors(xml);
      if (authors.length === 0) {
        failed++;
        console.warn(`  [${i + 1}/${target.length}] arxiv ${row.arxiv_id} no authors parsed`);
      } else if (authors.length === 1) {
        unchanged++;
        if (samples.length < 3) samples.push({ id: row.id, arxiv_id: row.arxiv_id, before, after: before, note: "arxiv has 1 author" });
      } else {
        const joined = authors.join(", ");
        const upd = await sb.from("pipeline_leads").update({ authors: joined }).eq("id", row.id);
        if (upd.error) {
          failed++;
          console.warn(`  [${i + 1}/${target.length}] update failed for id=${row.id}: ${upd.error.message}`);
        } else {
          updated++;
          if (samples.length < 3) samples.push({ id: row.id, arxiv_id: row.arxiv_id, before, after: joined });
        }
      }
    }
  } catch (e) {
    failed++;
    console.warn(`  [${i + 1}/${target.length}] error for ${row.arxiv_id}: ${e.message}`);
  }

  if ((i + 1) % 10 === 0) {
    console.log(`  progress: ${i + 1}/${target.length} (updated=${updated} unchanged=${unchanged} failed=${failed})`);
  }

  if (i < target.length - 1) await sleep(3000);
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

console.log("\n=== Final ===");
console.log(`  updated:   ${updated}`);
console.log(`  unchanged: ${unchanged}`);
console.log(`  failed:    ${failed}`);
console.log(`  elapsed:   ${elapsed}s`);

console.log("\n=== Sample before -> after ===");
for (const s of samples) {
  console.log(`  id=${s.id} arxiv=${s.arxiv_id}`);
  console.log(`    BEFORE: ${JSON.stringify(s.before)}`);
  console.log(`    AFTER:  ${JSON.stringify(s.after)}${s.note ? ` (${s.note})` : ""}`);
}
