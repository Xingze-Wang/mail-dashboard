/**
 * Final sweep: catch the 12 stragglers + any other rep with same
 * pattern (just in case). Match anywhere — both 杜雨洁 AND Chenyu —
 * across ALL not-yet-sent leads regardless of assigned_rep_id.
 *
 * The point is: if any draft contains a string that the customer would
 * read as a name, and that name doesn't match the sales_reps row's
 * sender_name, we re-render. Until we have proper "render at send
 * time" wired up, this string-replacement is the cheap fix.
 */
import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

// Pull rep names so we know what each rep should sign as
const { data: reps } = await sb.from("sales_reps").select("id, name, sender_name");
const senderById = new Map((reps ?? []).map((r) => [r.id, r.sender_name ?? r.name]));

// Find anything not-yet-sent containing 杜雨洁 OR Chenyu
const { data: leads } = await sb
  .from("pipeline_leads")
  .select("id, status, draft_html, draft_subject, assigned_rep_id")
  .or("draft_html.ilike.%杜雨洁%,draft_html.ilike.%Chenyu%,draft_subject.ilike.%杜雨洁%,draft_subject.ilike.%Chenyu%")
  .not("status", "in", "(sent,skipped,replied)");

console.log(`Sweep found ${leads?.length ?? 0} stragglers`);
let fixed = 0;
for (const l of leads ?? []) {
  const correctName = senderById.get(l.assigned_rep_id) ?? "";
  if (!correctName) continue;
  const newHtml = (l.draft_html ?? "")
    .replaceAll("杜雨洁", correctName)
    .replaceAll("Chenyu", correctName)
    .replaceAll("chenyu", correctName);
  const newSubject = (l.draft_subject ?? "")
    .replaceAll("杜雨洁", correctName)
    .replaceAll("Chenyu", correctName)
    .replaceAll("chenyu", correctName);
  if (newHtml === l.draft_html && newSubject === l.draft_subject) continue;
  await sb.from("pipeline_leads")
    .update({ draft_html: newHtml, draft_subject: newSubject })
    .eq("id", l.id);
  fixed++;
}
console.log(`Final sweep fixed: ${fixed}`);

const { count } = await sb
  .from("pipeline_leads")
  .select("id", { count: "exact", head: true })
  .or("draft_html.ilike.%杜雨洁%,draft_html.ilike.%Chenyu%")
  .not("status", "in", "(sent,skipped,replied)");
console.log(`Remaining stragglers: ${count}`);
