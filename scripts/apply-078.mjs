import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);
const sql = readFileSync("migrations/078-click-counts-and-model-bench.sql", "utf8");
const { error } = await sb.rpc("_exec_sql", { sql_text: sql });
if (error) { console.error("FAIL:", error.message); process.exit(1); }

const probeA = await sb.from("pipeline_leads").select("id, click_count, last_click_at").limit(1);
if (probeA.error) { console.error("Probe A failed:", probeA.error.message); process.exit(1); }

const probeB = await sb.from("model_prompts").select("id").limit(1);
if (probeB.error) { console.error("Probe B failed:", probeB.error.message); process.exit(1); }

const probeC = await sb.from("model_predictions").select("id").limit(1);
if (probeC.error) { console.error("Probe C failed:", probeC.error.message); process.exit(1); }

console.log("OK: click_count + model_prompts + model_predictions ready");
