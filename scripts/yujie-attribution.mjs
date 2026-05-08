import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

console.log("=== rep_id=2 (Yujie / 杜雨洁) row state ===");
const { data: rep } = await sb
  .from("sales_reps")
  .select("id, name, sender_name, sender_email, login_email, username, wechat_id, role, active, lark_open_id")
  .eq("id", 2)
  .maybeSingle();
console.log(JSON.stringify(rep, null, 2));

console.log("\n=== Recent emails attributed to rep_id=2 ===");
const { data: emails } = await sb
  .from("emails")
  .select("id, from, to, subject, rep_id, actor_rep_id, created_at")
  .or("rep_id.eq.2,actor_rep_id.eq.2")
  .order("created_at", { ascending: false })
  .limit(15);
for (const e of emails ?? []) {
  console.log(`  ${e.created_at?.slice(0, 16)}  rep=${e.rep_id} actor=${e.actor_rep_id}  from=${e.from}  to=${e.to?.slice(0, 30)}  subj="${e.subject?.slice(0, 40)}"`);
}

console.log("\n=== Search any email body referencing Chenyu in last 30d ===");
const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
const { data: chenyuEmails } = await sb
  .from("emails")
  .select("id, from, to, subject, rep_id, actor_rep_id, created_at, html")
  .ilike("html", "%Chenyu%")
  .gte("created_at", since30)
  .order("created_at", { ascending: false })
  .limit(10);
console.log(`Found ${chenyuEmails?.length ?? 0} email bodies mentioning Chenyu:`);
for (const e of chenyuEmails ?? []) {
  console.log(`  ${e.created_at?.slice(0, 16)}  rep=${e.rep_id} actor=${e.actor_rep_id}  from=${e.from}  to=${e.to?.slice(0, 30)}  subj="${e.subject?.slice(0, 40)}"`);
  // show the line containing Chenyu
  const html = (e.html ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
  const idx = html.toLowerCase().indexOf("chenyu");
  if (idx >= 0) console.log(`    body: ...${html.slice(Math.max(0, idx - 60), idx + 100)}...`);
}

console.log("\n=== rep_id=2 history: any old name fields? ===");
// Check if there's a sender_name history we missed
const { data: leads } = await sb
  .from("pipeline_leads")
  .select("id, draft_html, draft_subject, assigned_rep_id, status, created_at")
  .ilike("draft_html", "%Chenyu%")
  .order("created_at", { ascending: false })
  .limit(10);
console.log(`Found ${leads?.length ?? 0} pipeline_leads with Chenyu in draft_html:`);
for (const l of leads ?? []) {
  console.log(`  ${l.created_at?.slice(0, 16)}  lead_id=${l.id} assigned=${l.assigned_rep_id} status=${l.status}  subj="${l.draft_subject?.slice(0, 40)}"`);
}

console.log("\n=== email_templates rep_intro_format check ===");
const { data: tpls } = await sb
  .from("email_templates")
  .select("id, name, rep_intro_format, cta_signoff_format")
  .ilike("rep_intro_format", "%Chenyu%");
console.log(`Templates with Chenyu in rep_intro_format: ${tpls?.length ?? 0}`);
for (const t of tpls ?? []) console.log(`  ${t.name}`);
