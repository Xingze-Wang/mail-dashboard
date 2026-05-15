import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);
const sql = readFileSync("migrations/090-helper-learnings-fts.sql", "utf8");
const { error } = await sb.rpc("_exec_sql", { sql_text: sql });
if (error) { console.error("FAIL:", error.message); process.exit(1); }

// Probe: search for a known body fragment
const probe = await sb.rpc("helper_learnings_search", {
  query_text: "skill memory",
  rep_scope: 5,
  limit_n: 5,
});
if (probe.error) { console.error("Probe failed:", probe.error.message); process.exit(1); }
console.log("OK: helper_learnings FTS ready. Probe returned", probe.data?.length, "rows");
for (const r of probe.data ?? []) {
  console.log("  kind=" + r.kind, "rank=" + Number(r.rank).toFixed(3), "body=" + (r.body || "").slice(0, 50));
}
