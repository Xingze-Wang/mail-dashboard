import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);
const { data, error } = await sb
  .from("pending_onboarding")
  .select("id, lark_open_id, lark_name, claimed_name, claimed_email, claimed_wechat, claimed_role, status, step, created_at")
  .order("created_at", { ascending: false })
  .limit(10);
if (error) { console.error("ERR:", error.message); process.exit(1); }
console.log(`${data.length} pending_onboarding rows (most recent first):`);
for (const r of data) {
  console.log(`  ${r.created_at.slice(0,16)} ${r.status.padEnd(20)} step=${r.step.padEnd(15)} ${r.lark_name ?? '(no lark name)'} → claimed: ${r.claimed_name ?? '?'} / ${r.claimed_email ?? '?'} / wechat=${r.claimed_wechat ?? '?'}`);
  console.log(`    open_id=${r.lark_open_id} pending_id=${r.id}`);
}
