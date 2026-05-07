import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);
const sql = readFileSync("migrations/056-trust-level.sql", "utf8");
const { error } = await sb.rpc("_exec_sql", { sql_text: sql });
if (error) { console.error("FAIL:", error.message); process.exit(1); }
const probe = await sb
  .from("sales_reps")
  .select("id, name, trust_level, onboarded_at, trust_notes")
  .order("id")
  .limit(10);
if (probe.error) { console.error("Probe failed:", probe.error.message); process.exit(1); }
console.log("OK: sales_reps.trust_level / onboarded_at / trust_notes live");
console.log("Existing reps after backfill:");
for (const r of probe.data ?? []) {
  console.log(`  id=${r.id} ${r.name}: trust=${r.trust_level} onboarded_at=${r.onboarded_at}`);
}
