// Drive today's lead allocation from the same allocator the cron uses.
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
const { allocateForRep, alreadyAllocated } = await import("/Users/xingzewang/Desktop/mail/src/lib/allocator.ts");

const today = new Date().toISOString().slice(0, 10);
const { data: missions } = await sb
  .from("missions").select("id, rep_id, target, scope")
  .eq("due_date", today).eq("kind", "send").eq("status", "active");
console.log(`Found ${missions?.length || 0} send-missions for ${today}`);

for (const m of missions || []) {
  if (await alreadyAllocated(m.id, today)) {
    console.log(` rep=${m.rep_id} skip: already_allocated`);
    continue;
  }
  const pp = m.scope?.per_pool || { strong: 0, normal_cn: 0, normal_overseas: 0, normal_edu: 0 };
  const dp = m.scope?.direction_priority || [];
  const r = await allocateForRep({
    mission_id: m.id, rep_id: m.rep_id, due_date: today,
    per_pool: pp, direction_priority: dp,
    allocator: "manual:" + (process.env.USER || "ops"),
    shadow: false,
  });
  console.log(` rep=${m.rep_id} allocated=${r.total_allocated} per_pool_actual=${JSON.stringify(r.per_pool_actual)} underfilled=${r.underfilled}`);
}
const { count: unassigned } = await sb.from("pipeline_leads").select("id", { count: "exact", head: true }).is("assigned_rep_id", null);
const { count: allocLogs } = await sb.from("allocation_log").select("id", { count: "exact", head: true });
console.log(`\nUnassigned pool: ${unassigned}  allocation_log: ${allocLogs}`);
