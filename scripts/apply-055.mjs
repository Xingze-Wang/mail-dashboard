import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);
const sql = readFileSync("migrations/055-lark-triage.sql", "utf8");
const { error } = await sb.rpc("_exec_sql", { sql_text: sql });
if (error) { console.error("FAIL:", error.message); process.exit(1); }
const probe = await sb.from("lark_triage_decisions").select("lark_open_id").limit(1);
if (probe.error) { console.error("Probe failed:", probe.error.message); process.exit(1); }
const probe2 = await sb.from("pending_onboarding").select("claimed_role, lark_chat_id").limit(1);
if (probe2.error) { console.error("Probe2 failed:", probe2.error.message); process.exit(1); }
console.log("OK: lark_triage_decisions + pending_onboarding.claimed_role/lark_chat_id live");
