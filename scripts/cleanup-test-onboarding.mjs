/**
 * Clean up after scripts/test-onboarding-card.mjs.
 *
 * Removes any TEST_* pending_onboarding rows AND any sales_reps rows
 * that were accidentally created by an Approve click on the test card
 * (identifiable by lark_open_id starting with 'TEST_' or sender_email
 * = 'test_button_check@compute.miracleplus.com').
 *
 * Idempotent — safe to re-run; deletes nothing if the test data is
 * already gone.
 */
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

// Drop any TEST_* pending rows.
const { data: pendings, error: pErr } = await sb
  .from("pending_onboarding")
  .delete()
  .like("lark_open_id", "TEST_%")
  .select("id, lark_open_id");
if (pErr) {
  console.error("pending delete failed:", pErr.message);
} else {
  console.log(`Deleted ${pendings?.length ?? 0} test pending row(s).`);
  for (const p of pendings ?? []) console.log(`  - ${p.id} (${p.lark_open_id})`);
}

// Drop any sales_reps row matching the test email or TEST_ open_id.
const { data: reps, error: rErr } = await sb
  .from("sales_reps")
  .delete()
  .or("sender_email.eq.test_button_check@compute.miracleplus.com,lark_open_id.like.TEST_%")
  .select("id, name, sender_email");
if (rErr) {
  console.error("sales_reps delete failed:", rErr.message);
} else {
  console.log(`Deleted ${reps?.length ?? 0} test sales_reps row(s).`);
  for (const r of reps ?? []) console.log(`  - rep_id=${r.id} ${r.name} ${r.sender_email}`);
}

console.log("\nCleanup done.");
