/**
 * Replace stale "Chenyu" with "杜雨洁" in pipeline_leads.draft_html for
 * any lead assigned to rep_id=2 that's not yet sent. This unsticks the
 * 225 ready/drafted leads with stale name from the migration 053 rename.
 *
 * We don't touch status='sent' rows — those emails are already out the
 * door, can't recall. Their emails.html record stays as-is (audit trail
 * of what we actually sent, even though it was wrong).
 *
 * Also normalizes subject (defensively — current data shows subject
 * is fine but cheap to verify).
 */
import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

// Pull the not-yet-sent ones (status in ready/drafted/etc, not sent/skipped/replied).
const { data: leads } = await sb
  .from("pipeline_leads")
  .select("id, status, draft_html, draft_subject")
  .eq("assigned_rep_id", 2)
  .ilike("draft_html", "%Chenyu%")
  .not("status", "in", "(sent,skipped,replied)");

console.log(`Found ${leads?.length ?? 0} ready/drafted leads with Chenyu in draft_html`);

let fixed = 0;
let errors = 0;
for (const l of leads ?? []) {
  const newHtml = (l.draft_html ?? "")
    .replaceAll("Chenyu", "杜雨洁")
    .replaceAll("chenyu", "杜雨洁"); // case-insensitive cleanup
  const newSubject = (l.draft_subject ?? "")
    .replaceAll("Chenyu", "杜雨洁")
    .replaceAll("chenyu", "杜雨洁");
  if (newHtml === l.draft_html && newSubject === l.draft_subject) continue;
  const { error } = await sb
    .from("pipeline_leads")
    .update({ draft_html: newHtml, draft_subject: newSubject })
    .eq("id", l.id);
  if (error) {
    console.log(`  FAIL ${l.id}: ${error.message}`);
    errors++;
  } else {
    fixed++;
  }
}
console.log(`\nFixed: ${fixed}  Errors: ${errors}`);

// Verify nothing left for not-yet-sent
const { count: remaining } = await sb
  .from("pipeline_leads")
  .select("id", { count: "exact", head: true })
  .eq("assigned_rep_id", 2)
  .ilike("draft_html", "%Chenyu%")
  .not("status", "in", "(sent,skipped,replied)");
console.log(`Remaining not-yet-sent leads with Chenyu: ${remaining}`);
