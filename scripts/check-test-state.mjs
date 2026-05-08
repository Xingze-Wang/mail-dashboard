import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);
const { data: pending } = await sb
  .from("pending_onboarding")
  .select("id, lark_open_id, status, decided_at, decided_by_rep")
  .like("lark_open_id", "TEST_%");
console.log("Test pending rows:");
for (const p of pending ?? []) console.log(`  ${p.id} ${p.lark_open_id} status=${p.status} decided_by=${p.decided_by_rep} at ${p.decided_at}`);
const { data: reps } = await sb
  .from("sales_reps")
  .select("id, name, sender_email, lark_open_id")
  .or("sender_email.eq.test_button_check@compute.miracleplus.com,lark_open_id.like.TEST_%");
console.log("\nTest sales_reps rows:");
for (const r of reps ?? []) console.log(`  rep_id=${r.id} ${r.name} ${r.sender_email} ${r.lark_open_id}`);
