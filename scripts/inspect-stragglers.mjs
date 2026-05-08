import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);
const { data: leads } = await sb
  .from("pipeline_leads")
  .select("id, status, assigned_rep_id, draft_subject")
  .or("draft_html.ilike.%杜雨洁%,draft_html.ilike.%Chenyu%")
  .not("status", "in", "(sent,skipped,replied)");
console.log(`${leads?.length ?? 0} stragglers:`);
const byRep = {};
for (const l of leads ?? []) {
  byRep[l.assigned_rep_id] = (byRep[l.assigned_rep_id] ?? 0) + 1;
  console.log(`  rep=${l.assigned_rep_id} status=${l.status} subj="${l.draft_subject?.slice(0, 50)}"`);
}
console.log("\nBy rep:");
for (const [r, n] of Object.entries(byRep)) console.log(`  rep_id=${r}: ${n}`);
const { data: reps } = await sb.from("sales_reps").select("id, name, sender_name");
console.log("\nrep sender_name lookup:");
for (const r of reps ?? []) console.log(`  rep_id=${r.id}: name=${r.name} sender_name=${r.sender_name}`);
