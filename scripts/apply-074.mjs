import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);
const sql = readFileSync("migrations/074-mission-system.sql", "utf8");
const { error } = await sb.rpc("_exec_sql", { sql_text: sql });
if (error) { console.error("FAIL:", error.message); process.exit(1); }
// mission_progress uses mission_id as PK (not id), so probe with that.
for (const [t, col] of [
  ["quarterly_goals", "id"],
  ["team_focus", "id"],
  ["missions", "id"],
  ["mission_progress", "mission_id"],
]) {
  const probe = await sb.from(t).select(col).limit(1);
  if (probe.error) { console.error(`Probe ${t} failed:`, probe.error.message); process.exit(1); }
}
console.log("OK: mission system tables created");
