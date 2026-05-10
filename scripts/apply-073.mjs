// Apply migrations/073-jitr-offers.sql via _exec_sql.
// This is a renumber of the original 038-jitr-offers.sql (which collided
// with 038-bench-sim.sql). The migration is idempotent — re-running on
// prod where jitr_offers already exists is a no-op.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const sql = readFileSync("migrations/073-jitr-offers.sql", "utf8");
const { error } = await sb.rpc("_exec_sql", { sql_text: sql });
if (error) {
  console.error("FAIL:", error.message);
  process.exit(1);
}
const probe = await sb.from("jitr_offers").select("id").limit(1);
if (probe.error) {
  console.error("Probe failed:", probe.error.message);
  process.exit(1);
}
console.log("OK: jitr_offers exists");
