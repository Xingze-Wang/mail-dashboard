import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);
const sql = readFileSync("migrations/077-insights-llm-cache-and-congress-chime.sql", "utf8");
const { error } = await sb.rpc("_exec_sql", { sql_text: sql });
if (error) { console.error("FAIL:", error.message); process.exit(1); }

const probeA = await sb.from("insights_llm_cache").select("id").limit(1);
if (probeA.error) { console.error("Probe A failed:", probeA.error.message); process.exit(1); }

const probeB = await sb.from("helper_chime_in_log").select("id").limit(1);
if (probeB.error) { console.error("Probe B failed:", probeB.error.message); process.exit(1); }

console.log("OK: insights_llm_cache + helper_chime_in_log created");
