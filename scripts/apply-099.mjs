import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);
const sql = readFileSync("migrations/099-miracleplus-contacts-mirror.sql", "utf8");
const { error } = await sb.rpc("_exec_sql", { sql_text: sql });
if (error) { console.error("FAIL:", error.message); process.exit(1); }
console.log("ok — verifying table exists:");
const { data, error: probeErr } = await sb
  .from("miracleplus_contacts")
  .select("mp_id, email, email_canonical, application_progress, submitted_at, raw, first_seen_at")
  .limit(1);
if (probeErr) { console.error("probe FAIL:", probeErr.message); process.exit(1); }
console.log("✓ table reachable (rows so far:", data?.length ?? 0, ")");

// _exec_sql discards SELECT output (DDL only). Use _run_select_sql to
// confirm both indexes exist.
const { data: idxData, error: idxErr } = await sb.rpc("_run_select_sql", {
  sql_text: "SELECT indexname FROM pg_indexes WHERE tablename='miracleplus_contacts' ORDER BY indexname",
  sql_params: [],
});
if (idxErr) { console.error("index probe FAIL:", idxErr.message); process.exit(1); }
const idxRows = Array.isArray(idxData) ? idxData : (idxData?.rows ?? []);
const names = idxRows.map((r) => r.indexname).filter(Boolean);
console.log("✓ indexes:", names);
const expected = ["miracleplus_contacts_email_idx", "miracleplus_contacts_pkey", "miracleplus_contacts_submitted_idx"];
const missing = expected.filter((n) => !names.includes(n));
if (missing.length > 0) {
  console.error("MISSING indexes:", missing);
  process.exit(1);
}
console.log("✓ migration 099 applied cleanly.");
