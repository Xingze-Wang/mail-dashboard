import { createClient } from "@supabase/supabase-js";
const sb = createClient("https://erguqrisqtugfysofwdd.supabase.co","eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",{auth:{persistSession:false}});
const { data, error } = await sb.from("lark_messages").select("chat_id, message_id, role, text, created_at, raw, rep_id").order("created_at", {ascending:false}).limit(20);
if (error) { console.error(error.message); process.exit(1); }
console.log(`recent lark_messages: ${data.length}`);
for (const r of data) {
  const oid = r.raw?.event?.sender?.sender_id?.open_id ?? "(no oid)";
  console.log(`  ${r.created_at}  role=${r.role}  rep_id=${r.rep_id ?? "-"}  oid=${oid.slice(0,16)}  text=${(r.text||"").slice(0,80)}`);
}
console.log("\n--- orphans (user msgs with no rep_id) ---");
const orphans = data.filter(r => !r.rep_id && r.role === "user");
for (const r of orphans) {
  const oid = r.raw?.event?.sender?.sender_id?.open_id;
  console.log(`  open_id=${oid}  text="${(r.text||"").slice(0,60)}"  at=${r.created_at}`);
}
console.log("\n--- sales_reps with lark binding ---");
const { data: reps } = await sb.from("sales_reps").select("id, name, lark_open_id, lark_email").not("lark_open_id", "is", null);
for (const r of reps ?? []) console.log(`  rep_id=${r.id} name=${r.name} open_id=${r.lark_open_id?.slice(0,16)}...`);
if (!reps || reps.length === 0) console.log("  (no reps bound yet)");
