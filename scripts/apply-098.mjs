import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);
const sql = readFileSync("migrations/098-persons-social-links.sql", "utf8");
const { error } = await sb.rpc("_exec_sql", { sql_text: sql });
if (error) { console.error("FAIL:", error.message); process.exit(1); }
console.log("ok — verifying columns exist:");
const { data, error: probeErr } = await sb
  .from("persons")
  .select("id, homepage, twitter_handle")
  .limit(1);
if (probeErr) { console.error("probe FAIL:", probeErr.message); process.exit(1); }
console.log("✓ both columns reachable. sample row:", data?.[0]);
// Note: _exec_sql discards SELECT output (DDL exec only). Use _run_select_sql
// for the index probe. We still handle both array and {rows} envelope shapes
// in case the RPC's return signature evolves.
const { data: idxCheck, error: idxErr } = await sb.rpc("_run_select_sql", {
  sql_text: "SELECT indexname FROM pg_indexes WHERE tablename='persons' AND indexname='persons_needs_enrichment_idx'",
  sql_params: [],
});
if (idxErr) { console.error("index probe FAIL:", idxErr.message); process.exit(1); }
const idxRows = Array.isArray(idxCheck) ? idxCheck : (idxCheck?.rows ?? []);
console.log("✓ partial index exists:", idxRows.length > 0 ? idxRows[0]?.indexname ?? "yes" : "NO — rerun migration");
if (idxRows.length === 0) process.exit(1);
