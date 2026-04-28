// One-shot backfill for pipeline_leads.draft_original_html / draft_original_subject.
//
// Why:
//   The drift miner only mines leads where draft_original_html is populated
//   (it diffs the AI snapshot vs the sales-edited final). Until very recently,
//   any lead that was re-queued via /api/config/assignment had its
//   draft_original_html nulled out, AND historical leads pre-dating the
//   snapshot logic never had it written at all. As a result the miner sees
//   ~0 mineable pairs.
//
// What it does (best-effort recovery):
//   For every lead where draft_html IS NOT NULL, draft_original_html IS NULL,
//   status IN ('sent','replied','wechat_added','ready'), AND
//   draft_edit_distance is 0 OR NULL (= confirmed unedited), copy
//   draft_html → draft_original_html and draft_subject → draft_original_subject.
//
//   This is safe because draft_edit_distance=0 means sales did not change
//   the draft, so the current draft IS the AI's original. Edited rows
//   (distance > 0) are unrecoverable — the original was overwritten — and
//   we deliberately leave those alone rather than corrupt the baseline.

import { createClient } from "@supabase/supabase-js";

const url = "https://erguqrisqtugfysofwdd.supabase.co";
const key =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM";
const sb = createClient(url, key);

const STATUSES = ["sent", "replied", "wechat_added", "ready"];

async function countPopulated(label) {
  const { count, error } = await sb
    .from("pipeline_leads")
    .select("id", { count: "exact", head: true })
    .not("draft_original_html", "is", null);
  if (error) throw error;
  console.log(`  ${label}: ${count} rows have draft_original_html populated`);
  return count;
}

console.log("\n=== Step 0: snapshot ===");
const before = await countPopulated("BEFORE");

console.log("\n=== Step 1: load candidates (paginated) ===");
const candidates = [];
const PAGE = 1000;
let from = 0;
for (;;) {
  const { data, error } = await sb
    .from("pipeline_leads")
    .select("id, draft_subject, draft_html, draft_edit_distance, status")
    .in("status", STATUSES)
    .not("draft_html", "is", null)
    .is("draft_original_html", null)
    .or("draft_edit_distance.eq.0,draft_edit_distance.is.null")
    .range(from, from + PAGE - 1);
  if (error) {
    console.error("  load failed:", error.message);
    process.exit(1);
  }
  if (!data || data.length === 0) break;
  candidates.push(...data);
  if (data.length < PAGE) break;
  from += PAGE;
}
console.log(`  candidates: ${candidates.length}`);

if (candidates.length === 0) {
  console.log("\n  nothing to backfill — exiting.");
  console.log("\n=== Done ===");
  process.exit(0);
}

console.log("\n=== Step 2: update (one-by-one for clear error reporting) ===");
let updated = 0;
let failed = 0;
for (const row of candidates) {
  const { error } = await sb
    .from("pipeline_leads")
    .update({
      draft_original_html: row.draft_html,
      draft_original_subject: row.draft_subject ?? null,
    })
    .eq("id", row.id);
  if (error) {
    failed++;
    if (failed <= 5) console.error(`  ${row.id}: ${error.message}`);
  } else {
    updated++;
    if (updated % 100 === 0) console.log(`  …${updated} updated`);
  }
}
console.log(`  updated: ${updated}, failed: ${failed}`);

console.log("\n=== Step 3: verify ===");
const after = await countPopulated("AFTER");
console.log(`\n  net delta: +${after - before}`);

console.log("\n=== Done ===");
