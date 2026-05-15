import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);
const sql = readFileSync("migrations/087-rep-questions-curriculum.sql", "utf8");
const { error } = await sb.rpc("_exec_sql", { sql_text: sql });
if (error) { console.error("FAIL:", error.message); process.exit(1); }
const probeQ = await sb.from("rep_questions").select("id").limit(1);
if (probeQ.error) { console.error("Probe rep_questions failed:", probeQ.error.message); process.exit(1); }
const probeT = await sb.from("canonical_onboarding_topics").select("id").limit(1);
if (probeT.error) { console.error("Probe canonical_onboarding_topics failed:", probeT.error.message); process.exit(1); }
console.log("OK: rep_questions + canonical_onboarding_topics tables ready");
