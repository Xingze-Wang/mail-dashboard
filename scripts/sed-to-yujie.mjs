/**
 * The user wants the rep's name to render as "Yujie" in outbound
 * emails (not 杜雨洁). Two reasons emerged from real data:
 *  1. The customer-facing email template signs "我是奇绩创坛的 X" — X
 *     is more natural as "Yujie" (English/pinyin) for academics who
 *     mix Chinese/English in research correspondence.
 *  2. The DB row has name=杜雨洁 (set via lark backfill commit fc59117),
 *     but sender_name should be the customer-facing handle. Decoupling
 *     here.
 *
 * Now that we previously sed'd Chenyu → 杜雨洁 by mistake (used name
 * instead of sender_name), this runs the second-leg fix: 杜雨洁 → Yujie
 * in all not-yet-sent drafts AND on the sales_reps row's sender_name.
 */
import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

// Step 1: not-yet-sent drafts with 杜雨洁 → Yujie
const { data: leads } = await sb
  .from("pipeline_leads")
  .select("id, status, draft_html, draft_subject")
  .eq("assigned_rep_id", 2)
  .ilike("draft_html", "%杜雨洁%")
  .not("status", "in", "(sent,skipped,replied)");

console.log(`Found ${leads?.length ?? 0} not-yet-sent leads with 杜雨洁`);
let fixed = 0;
for (const l of leads ?? []) {
  const newHtml = (l.draft_html ?? "").replaceAll("杜雨洁", "Yujie");
  const newSubject = (l.draft_subject ?? "").replaceAll("杜雨洁", "Yujie");
  await sb.from("pipeline_leads")
    .update({ draft_html: newHtml, draft_subject: newSubject })
    .eq("id", l.id);
  fixed++;
}
console.log(`Fixed ${fixed} drafts`);

// Step 2: sales_reps.sender_name = "Yujie" (keep name=杜雨洁 for internal display)
const { error } = await sb
  .from("sales_reps")
  .update({ sender_name: "Yujie" })
  .eq("id", 2);
if (error) console.log(`sender_name update failed: ${error.message}`);
else console.log(`✓ rep_id=2 sender_name → Yujie (kept name=杜雨洁 for internal)`);

// Verify
const { count } = await sb
  .from("pipeline_leads")
  .select("id", { count: "exact", head: true })
  .eq("assigned_rep_id", 2)
  .ilike("draft_html", "%杜雨洁%")
  .not("status", "in", "(sent,skipped,replied)");
console.log(`\nRemaining not-yet-sent leads with 杜雨洁: ${count}`);
const { count: chenyuLeft } = await sb
  .from("pipeline_leads")
  .select("id", { count: "exact", head: true })
  .eq("assigned_rep_id", 2)
  .ilike("draft_html", "%Chenyu%")
  .not("status", "in", "(sent,skipped,replied)");
console.log(`Remaining not-yet-sent leads with Chenyu: ${chenyuLeft}`);
