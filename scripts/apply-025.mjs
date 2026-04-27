// Apply migrations/025-email-history-view.sql via the Supabase
// _exec_sql RPC. The repo's older convention was "paste into SQL
// editor"; this script automates the same thing for non-interactive
// runs. After apply, queries the new view to confirm shape.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://erguqrisqtugfysofwdd.supabase.co";
const SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM";

const sql = readFileSync("migrations/025-email-history-view.sql", "utf8");

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

console.log("Applying migrations/025-email-history-view.sql...");
const { error: execErr } = await sb.rpc("_exec_sql", { sql_text: sql });
if (execErr) {
  console.error("FAILED:", execErr.message);
  process.exit(1);
}
console.log("  OK: view created");

// Verify by querying the view through the REST endpoint.
const { count, error: cErr } = await sb
  .from("email_history")
  .select("*", { count: "exact", head: true });
if (cErr) {
  console.error("View created but query failed:", cErr.message);
  process.exit(1);
}
console.log(`  OK: email_history has ${count} rows`);

const { data: sample } = await sb
  .from("email_history")
  .select("email_id, latest_status, was_clicked, was_bounced, click_count")
  .eq("was_clicked", true)
  .limit(3);
console.log(`  Sample (was_clicked=true):`);
for (const r of sample ?? []) {
  console.log(`    ${r.email_id}  status=${r.latest_status}  clicks=${r.click_count}`);
}

console.log("Done.");
