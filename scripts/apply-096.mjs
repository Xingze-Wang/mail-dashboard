import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);
const sql = readFileSync("migrations/096-explain-select-sql-rpc.sql", "utf8");
const { error } = await sb.rpc("_exec_sql", { sql_text: sql });
if (error) { console.error("FAIL:", error.message); process.exit(1); }

// Probe: valid SQL passes
const ok = await sb.rpc("_explain_sql", { sql_text: "select 1 as one", sql_params: [] });
console.log("valid sql →", JSON.stringify(ok.data));

// Probe: bad column fails
const bad = await sb.rpc("_explain_sql", { sql_text: "select wechat_added_at from pipeline_leads limit 1", sql_params: [] });
console.log("hallucinated col →", JSON.stringify(bad.data));

// Probe: bad table fails
const bad2 = await sb.rpc("_explain_sql", { sql_text: "select * from imaginary_table", sql_params: [] });
console.log("missing table →", JSON.stringify(bad2.data));
