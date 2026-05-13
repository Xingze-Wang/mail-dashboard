import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const sql = readFileSync("migrations/082-shared-pool-allocation.sql", "utf8");
const { error } = await sb.rpc("_exec_sql", { sql_text: sql });
if (error) {
  console.error("FAIL:", error.message);
  process.exit(1);
}

const probe1 = await sb
  .from("rep_daily_quotas")
  .select("rep_id, per_pool")
  .order("rep_id");
if (probe1.error) {
  console.error("Probe quotas failed:", probe1.error.message);
  process.exit(1);
}
console.log("OK: rep_daily_quotas seeded:");
for (const r of probe1.data || []) {
  console.log(`  rep_id=${r.rep_id} per_pool=${JSON.stringify(r.per_pool)}`);
}

const probe2 = await sb.from("v_lead_pool").select("id, pool_key").limit(3);
if (probe2.error) {
  console.error("Probe v_lead_pool failed:", probe2.error.message);
  process.exit(1);
}
console.log(`OK: v_lead_pool returns ${probe2.data?.length ?? 0} sample rows`);

const probe3a = await sb.from("allocation_log").select("id").limit(1);
const probe3b = await sb.from("rep_daily_quotas_override").select("id").limit(1);
if (probe3a.error) {
  console.error("Probe allocation_log failed:", probe3a.error.message);
  process.exit(1);
}
if (probe3b.error) {
  console.error("Probe override failed:", probe3b.error.message);
  process.exit(1);
}
console.log("OK: allocation_log + rep_daily_quotas_override tables exist");
