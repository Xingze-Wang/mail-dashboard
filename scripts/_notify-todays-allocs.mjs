import { readFileSync } from "node:fs";
const env = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}
const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);
const { notifyRepOfAllocation } = await import("/Users/xingzewang/Desktop/mail/src/lib/allocation-notifier.ts");

const today = new Date().toISOString().slice(0, 10);
const { data: rows } = await sb
  .from("allocation_log")
  .select("rep_id, pool_key, lead_ids, notification_status")
  .eq("due_date", today)
  .is("notification_status", null);

console.log("Unnotified allocations today:", rows?.length || 0);

// Aggregate per rep
const perRep = new Map();
for (const r of rows || []) {
  let agg = perRep.get(r.rep_id);
  if (!agg) {
    agg = { per_pool_actual: { strong: 0, normal_cn: 0, normal_overseas: 0, normal_edu: 0 }, total_allocated: 0 };
    perRep.set(r.rep_id, agg);
  }
  const count = Array.isArray(r.lead_ids) ? r.lead_ids.length : 0;
  agg.per_pool_actual[r.pool_key] = (agg.per_pool_actual[r.pool_key] || 0) + count;
  agg.total_allocated += count;
}

for (const [repId, agg] of perRep) {
  const status = await notifyRepOfAllocation({
    rep_id: repId,
    due_date: today,
    per_pool_actual: agg.per_pool_actual,
    underfilled: [],
    total_allocated: agg.total_allocated,
  });
  console.log(`rep=${repId} total=${agg.total_allocated} → ${status}`);
}
