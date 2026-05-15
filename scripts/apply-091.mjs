import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);
for (const f of ["migrations/091-dynamic-writes.sql", "migrations/091b-run-write-sql-rpc.sql"]) {
  const sql = readFileSync(f, "utf8");
  const { error } = await sb.rpc("_exec_sql", { sql_text: sql });
  if (error) { console.error(`FAIL ${f}:`, error.message); process.exit(1); }
  console.log("OK:", f);
}
// Probes
const probeTable = await sb.from("dynamic_writes").select("id").limit(1);
if (probeTable.error) { console.error("table probe failed:", probeTable.error.message); process.exit(1); }
const probeLog = await sb.from("db_write_log").select("id").limit(1);
if (probeLog.error) { console.error("log probe failed:", probeLog.error.message); process.exit(1); }
console.log("All tables ready.");
