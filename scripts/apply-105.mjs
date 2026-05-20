import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const sql = readFileSync("migrations/105-paper-type-log.sql", "utf8");
const { error } = await sb.rpc("_exec_sql", { sql_text: sql });
if (error) { console.error("FAIL:", error.message); process.exit(1); }

const { data, error: probeErr } = await sb
  .from("pipeline_leads")
  .select("id, paper_type, paper_type_reason")
  .limit(1);
if (probeErr) { console.error("probe FAIL:", probeErr.message); process.exit(1); }
console.log("✓ migration 105 applied. Sample keys:", data?.[0] ? Object.keys(data[0]) : "(empty)");
