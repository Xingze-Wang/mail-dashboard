/**
 * Set Ethan up properly post-binding (rep_id=3).
 *
 * Changes:
 *   1. sender_name → "Ethan" (English handle, parallel to Yujie's pattern)
 *   2. onboarded_at → now() so trust_level + follow-up cron windows work
 *   3. Sweep his 744 draft_html for any name-other-than-Ethan and swap
 *   4. Apply the same to draft_subject
 *
 * Late-binding placeholders (commit 67601f4) handle reassignment going
 * forward but his EXISTING drafts are pre-placeholder and have baked
 * names. This is a one-shot cleanup.
 */
import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const TARGET = "Ethan";
const REP_ID = 3;

// Step 1+2: rename + reset onboarding stamp
console.log(`Step 1+2: sender_name → "${TARGET}", onboarded_at → now()`);
const { error: updErr } = await sb
  .from("sales_reps")
  .update({
    sender_name: TARGET,
    onboarded_at: new Date().toISOString(),
  })
  .eq("id", REP_ID);
if (updErr) {
  console.error("FAIL:", updErr.message);
  process.exit(1);
}

// Step 3: sweep drafts (only not-yet-sent)
console.log(`Step 3: sweep draft_html for not-yet-sent leads owned by rep_id=${REP_ID}`);
const { data: leads } = await sb
  .from("pipeline_leads")
  .select("id, draft_html, draft_subject")
  .eq("assigned_rep_id", REP_ID)
  .not("status", "in", "(sent,skipped,replied)");
console.log(`  ${leads?.length ?? 0} drafts to potentially update`);

// Build set of "wrong" names — anything that was once an Ethan-related
// label but isn't "Ethan". Includes the Chinese name, Chenyu legacy, etc.
const WRONG_NAMES = ["曹鸿宇泽", "Chenyu", "chenyu"];
let fixed = 0;
for (const l of leads ?? []) {
  let html = l.draft_html ?? "";
  let subject = l.draft_subject ?? "";
  let changed = false;
  for (const w of WRONG_NAMES) {
    if (html.includes(w)) { html = html.split(w).join(TARGET); changed = true; }
    if (subject.includes(w)) { subject = subject.split(w).join(TARGET); changed = true; }
  }
  if (!changed) continue;
  await sb.from("pipeline_leads").update({ draft_html: html, draft_subject: subject }).eq("id", l.id);
  fixed++;
}
console.log(`  fixed ${fixed} drafts`);

console.log("\n=== Verify ===");
const { data: rep } = await sb
  .from("sales_reps")
  .select("sender_name, onboarded_at")
  .eq("id", REP_ID)
  .maybeSingle();
console.log(`  rep_id=${REP_ID} sender_name=${rep?.sender_name} onboarded_at=${rep?.onboarded_at}`);

const { count: stillStale } = await sb
  .from("pipeline_leads")
  .select("id", { count: "exact", head: true })
  .eq("assigned_rep_id", REP_ID)
  .not("status", "in", "(sent,skipped,replied)")
  .or("draft_html.ilike.%曹鸿宇泽%,draft_html.ilike.%Chenyu%");
console.log(`  stale drafts remaining: ${stillStale}`);
