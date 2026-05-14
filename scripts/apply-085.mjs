import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const sql = readFileSync("migrations/085-lark-webhook-trace.sql", "utf8");
const { error } = await sb.rpc("_exec_sql", { sql_text: sql });
if (error) {
  console.error("FAIL:", error.message);
  process.exit(1);
}

// Probe: insert a row, verify accepted, delete it
const probe = await sb.from("lark_webhook_trace").insert({
  event_type: "probe.085",
  is_card_action: false,
  header: { probe: true },
}).select("id").maybeSingle();
if (probe.error) {
  console.error("Probe insert failed:", probe.error.message);
  process.exit(1);
}
await sb.from("lark_webhook_trace").delete().eq("id", probe.data.id);
console.log("OK: lark_webhook_trace created (verified by round-trip insert)");
