import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);
const sql = readFileSync("migrations/053-rename-chenyu-to-yujie.sql", "utf8");
const { error } = await sb.rpc("_exec_sql", { sql_text: sql });
if (error) { console.error("FAIL:", error.message); process.exit(1); }
// Probe — confirm the rename actually landed on row 2.
const probe = await sb
  .from("sales_reps")
  .select("id,name,sender_email,login_email")
  .eq("id", 2)
  .single();
if (probe.error) { console.error("Probe failed:", probe.error.message); process.exit(1); }
if (probe.data.name !== "Yujie" || probe.data.sender_email !== "yujie@compute.miracleplus.com") {
  console.error("FAIL: row 2 did not flip — got", probe.data);
  process.exit(1);
}
console.log("OK: sales_reps id=2 → Yujie / yujie@compute.miracleplus.com");
