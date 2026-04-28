// Clean up brief_lookups based on real-world rules from product owner:
//   1. Anything before 2026-04-23 was Leo (Chenyu's first day was 04-23).
//   2. The 04-20 midnight-UTC rows with no lead_id are placeholders → delete.
//   3. The literal "test" row → delete.
//
// This runs AFTER the heuristic backfill, so it overrides whatever the
// heuristic guessed when reality (the date-cutoff rule) says otherwise.

import { createClient } from "@supabase/supabase-js";

const url = "https://erguqrisqtugfysofwdd.supabase.co";
const key = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM";
const sb = createClient(url, key);

const CUTOFF = "2026-04-23T00:00:00+00:00";  // Chenyu's first day, Beijing morning
const LEO_ID = 1;

console.log("=== Step 0: snapshot ===");
const before = await sb.from("brief_lookups")
  .select("id,query,lead_id,marked_by_rep_id,wechat_at,created_at")
  .eq("added_wechat", true);
console.log(`  total wechat rows: ${before.data.length}`);

// Identify placeholders: 04-20 midnight UTC + no lead_id + .edu/.cn-style fake names
// Plus the literal "test" row.
const placeholders = before.data.filter(r => {
  if (r.query === "test") return true;
  if (r.lead_id) return false; // has a real lead → keep
  // No lead_id AND wechat_at exactly midnight on 04-20 = bulk-imported placeholder
  if (r.wechat_at === "2026-04-20T00:00:00+00:00") return true;
  return false;
});

console.log("\n=== Step 1: delete placeholders ===");
console.log(`  candidates: ${placeholders.length}`);
for (const p of placeholders) {
  console.log(`  - ${p.id.slice(0,8)} ${p.wechat_at?.slice(0,10)} ${(p.query||'').slice(0,40)}`);
}
let deleted = 0;
for (const p of placeholders) {
  const r = await sb.from("brief_lookups").delete().eq("id", p.id);
  if (r.error) { console.error(`    FAIL ${p.id}: ${r.error.message}`); continue; }
  deleted++;
}
console.log(`  deleted: ${deleted}`);

// Now: for everything that remains with wechat_at < CUTOFF, force rep = Leo.
console.log("\n=== Step 2: reattribute pre-cutoff rows to Leo ===");
const remaining = await sb.from("brief_lookups")
  .select("id,query,marked_by_rep_id,wechat_at")
  .eq("added_wechat", true);

const toLeo = remaining.data.filter(r => {
  if (!r.wechat_at) return false;
  return r.wechat_at < CUTOFF;
});
console.log(`  pre-${CUTOFF.slice(0,10)} rows to reattribute: ${toLeo.length}`);

let reattributed = 0;
for (const r of toLeo) {
  if (r.marked_by_rep_id === LEO_ID) continue; // already Leo
  const upd = await sb.from("brief_lookups")
    .update({ marked_by_rep_id: LEO_ID, marked_by_email: "leo@compute.miracleplus.com" })
    .eq("id", r.id);
  if (upd.error) { console.error(`    FAIL ${r.id}: ${upd.error.message}`); continue; }
  reattributed++;
}
console.log(`  reattributed: ${reattributed}`);

console.log("\n=== Final state ===");
const after = await sb.from("brief_lookups")
  .select("marked_by_rep_id,wechat_at")
  .eq("added_wechat", true);
console.log(`  total wechat rows: ${after.data.length}`);
const reps = await sb.from("sales_reps").select("id,name");
const repName = new Map((reps.data ?? []).map(r => [r.id, r.name]));
const byRep = new Map();
for (const r of after.data) {
  const k = r.marked_by_rep_id ?? "(null)";
  byRep.set(k, (byRep.get(k) ?? 0) + 1);
}
for (const [repId, count] of [...byRep].sort((a,b) => String(a[0]).localeCompare(String(b[0])))) {
  const name = repId === "(null)" ? "(unattributed)" : (repName.get(repId) ?? `rep#${repId}`);
  console.log(`  ${name.padEnd(20)} ${count}`);
}
