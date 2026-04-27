// One-shot data cleanup for brief_lookups.
//
// Two deletes:
//   1. Rows where notes='placeholder' AND added_wechat=true
//      (the 17 Leo padding rows seeded by scripts/seed-leo-placeholders.mjs).
//   2. Rows where added_wechat=true AND wechat_at < 2026-04-23T00:00:00Z
//      (Chenyu's first day; nothing real exists before this).
//
// Idempotent: re-running after a successful pass should be a no-op because
// both predicates will match zero rows.
//
// Touches only brief_lookups. sales_reps is read-only (used for nice names).

import { createClient } from "@supabase/supabase-js";

const url = "https://erguqrisqtugfysofwdd.supabase.co";
const key = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM";
const sb = createClient(url, key);

const CUTOFF = "2026-04-23T00:00:00+00:00"; // Chenyu's first day

async function snapshot(label) {
  const { data, error } = await sb
    .from("brief_lookups")
    .select("id,marked_by_rep_id,wechat_at,notes")
    .eq("added_wechat", true);
  if (error) throw error;

  const reps = await sb.from("sales_reps").select("id,name");
  if (reps.error) throw reps.error;
  const repName = new Map((reps.data ?? []).map((r) => [r.id, r.name]));

  const byRep = new Map();
  for (const r of data) {
    const k = r.marked_by_rep_id ?? "(null)";
    byRep.set(k, (byRep.get(k) ?? 0) + 1);
  }

  const placeholders = data.filter((r) => r.notes === "placeholder").length;
  const preCutoff = data.filter(
    (r) => r.wechat_at && r.wechat_at < CUTOFF
  ).length;

  console.log(`\n=== ${label} ===`);
  console.log(`  total wechat rows:                     ${data.length}`);
  console.log(`  notes='placeholder':                   ${placeholders}`);
  console.log(`  wechat_at < ${CUTOFF.slice(0, 10)}:           ${preCutoff}`);
  console.log("  per-rep breakdown:");
  for (const [repId, count] of [...byRep].sort((a, b) =>
    String(a[0]).localeCompare(String(b[0]))
  )) {
    const name =
      repId === "(null)"
        ? "(unattributed)"
        : repName.get(repId) ?? `rep#${repId}`;
    console.log(`    ${name.padEnd(20)} ${count}`);
  }

  return data;
}

await snapshot("BEFORE");

// --- Delete #1: placeholder rows ---
console.log("\n--- delete #1: notes='placeholder' AND added_wechat=true ---");
{
  const found = await sb
    .from("brief_lookups")
    .select("id")
    .eq("added_wechat", true)
    .eq("notes", "placeholder");
  if (found.error) throw found.error;
  console.log(`  matched: ${found.data.length}`);

  const del = await sb
    .from("brief_lookups")
    .delete()
    .eq("added_wechat", true)
    .eq("notes", "placeholder")
    .select("id");
  if (del.error) throw del.error;
  console.log(`  deleted: ${del.data.length}`);
}

// --- Delete #2: pre-cutoff rows ---
console.log(
  `\n--- delete #2: added_wechat=true AND wechat_at < ${CUTOFF} ---`
);
{
  const found = await sb
    .from("brief_lookups")
    .select("id,wechat_at")
    .eq("added_wechat", true)
    .lt("wechat_at", CUTOFF);
  if (found.error) throw found.error;
  console.log(`  matched: ${found.data.length}`);

  const del = await sb
    .from("brief_lookups")
    .delete()
    .eq("added_wechat", true)
    .lt("wechat_at", CUTOFF)
    .select("id");
  if (del.error) throw del.error;
  console.log(`  deleted: ${del.data.length}`);
}

await snapshot("AFTER");

// --- Verify earliest remaining wechat_at >= cutoff ---
console.log("\n--- verify earliest remaining wechat_at ---");
const earliest = await sb
  .from("brief_lookups")
  .select("id,wechat_at,marked_by_rep_id")
  .eq("added_wechat", true)
  .not("wechat_at", "is", null)
  .order("wechat_at", { ascending: true })
  .limit(1);
if (earliest.error) throw earliest.error;

if (earliest.data.length === 0) {
  console.log("  no rows with wechat_at remain");
} else {
  const e = earliest.data[0];
  const ok = e.wechat_at >= CUTOFF;
  console.log(`  earliest wechat_at: ${e.wechat_at}`);
  console.log(`  cutoff:             ${CUTOFF}`);
  console.log(`  >= cutoff?          ${ok ? "YES" : "NO -- FAIL"}`);
  if (!ok) process.exit(1);
}

console.log("\nDone.");
