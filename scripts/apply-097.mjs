import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);
const sql = readFileSync("migrations/097-template-rep-approval-stage.sql", "utf8");
const { error } = await sb.rpc("_exec_sql", { sql_text: sql });
if (error) { console.error("FAIL:", error.message); process.exit(1); }
console.log("ok — verifying columns exist:");
const { data, error: probeErr } = await sb
  .from("email_templates")
  .select("id, proposed_to_rep_at, rep_approved_at, rep_rejection_reason")
  .limit(1);
if (probeErr) { console.error("probe FAIL:", probeErr.message); process.exit(1); }
console.log("✓ all three columns reachable. sample row:", data?.[0]);
