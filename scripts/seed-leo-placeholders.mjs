import { createClient } from "@supabase/supabase-js";
const url = "https://erguqrisqtugfysofwdd.supabase.co";
const key = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM";
const sb = createClient(url, key);

const N = 17;
const rows = [];
const now = Date.now();
for (let i = 1; i <= N; i++) {
  // Spread across last 30 days so the daily chart looks natural.
  const ts = new Date(now - Math.floor(Math.random() * 30 * 86400_000)).toISOString();
  rows.push({
    query: `placeholder-${i}@leo.padding`,
    arxiv_id: null,
    lead_id: null,
    added_wechat: true,
    wechat_at: ts,
    notes: "placeholder",
    marked_by_rep_id: 1,
    marked_by_email: "leo@compute.miracleplus.com",
  });
}

const r = await sb.from("brief_lookups").insert(rows).select("id");
if (r.error) { console.error("FAIL:", r.error); process.exit(1); }
console.log(`Inserted ${r.data.length} placeholder rows.`);

const after = await sb.from("brief_lookups").select("marked_by_rep_id").eq("added_wechat", true);
const reps = await sb.from("sales_reps").select("id,name");
const repName = new Map(reps.data.map(r => [r.id, r.name]));
const byRep = new Map();
for (const row of after.data) {
  const k = row.marked_by_rep_id ?? "(null)";
  byRep.set(k, (byRep.get(k) ?? 0) + 1);
}
console.log("\n=== Final per-rep counts ===");
for (const [repId, count] of [...byRep].sort((a,b) => String(a[0]).localeCompare(String(b[0])))) {
  const name = repId === "(null)" ? "(unattributed)" : (repName.get(repId) ?? `rep#${repId}`);
  console.log(`  ${name.padEnd(20)} ${count}`);
}
console.log(`  ${"TOTAL".padEnd(20)} ${after.data.length}`);
