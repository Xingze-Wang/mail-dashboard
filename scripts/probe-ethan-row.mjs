import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);
const { data } = await sb
  .from("sales_reps")
  .select("id, name, sender_email, login_email, lark_open_id, role, active, onboarded_at")
  .or("sender_email.ilike.%ethan%,name.ilike.%ethan%,name.eq.曹鸿宇泽,login_email.ilike.%ethan%")
  .order("id");
console.log("Reps matching ethan / 曹鸿宇泽:");
for (const r of data ?? []) {
  console.log(`  rep_id=${r.id} ${r.name} ${r.sender_email} login=${r.login_email} role=${r.role} active=${r.active} open_id=${r.lark_open_id}`);
}
