import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);
const { data: lead } = await sb
  .from("pipeline_leads")
  .select("id, draft_html, draft_subject, status, assigned_rep_id")
  .eq("id", "66249822-54af-4c62-92c4-67f4c0873746")
  .maybeSingle();
if (!lead) { console.log("Lead not found"); process.exit(0); }
console.log(`Lead status=${lead.status} rep=${lead.assigned_rep_id}`);
const html = (lead.draft_html ?? "").split("Chenyu").join("Yujie");
const subject = (lead.draft_subject ?? "").split("Chenyu").join("Yujie");
if (html === lead.draft_html && subject === lead.draft_subject) {
  console.log("Nothing to change.");
  process.exit(0);
}
const { error } = await sb
  .from("pipeline_leads")
  .update({ draft_html: html, draft_subject: subject })
  .eq("id", lead.id);
if (error) {
  console.error("FAIL:", error.message);
  process.exit(1);
}
console.log("✓ Replaced Chenyu → Yujie in the replied lead's draft");
