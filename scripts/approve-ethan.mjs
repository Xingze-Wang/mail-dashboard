/**
 * Manual approval for the stuck Ethan onboarding.
 *
 * Discovery: Ethan ALREADY EXISTS as rep_id=3 with sender_email
 * ethan@compute.miracleplus.com but lark_open_id=null. The candidate
 * flow's existing-rep detection (Task 14) would have caught this and
 * proposed a bind, BUT the candidate typed the corrupted email
 * "ethancompute.miracleplus.com" thinking it was the prefix, which
 * never matched ethan@compute.miracleplus.com in the collision check.
 *
 * Right move: bind his lark_open_id (ou_5b77f6177e27a09e54b1b63c9c0181e6)
 * to rep_id=3, delete the pending row. He logs in with whatever
 * password is already on rep_id=3 (NOT the new password he set in
 * onboarding — that was lost when the corrupted email blocked the
 * provisioning path).
 *
 * Note for follow-up: tighten the email-prefix validation in
 * onboarding.ts so a candidate typing "ethancompute.miracleplus.com"
 * gets rejected at input rather than getting written as a corrupt
 * concatenated address.
 */
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const PENDING_ID = "1cf9be11-3627-4dd1-ac55-feb7729b8b45";
const ETHAN_OPEN_ID = "ou_5b77f6177e27a09e54b1b63c9c0181e6";
const ETHAN_REP_ID = 3;

// Bind the Lark open_id to the existing rep row.
const { error: bindErr } = await sb
  .from("sales_reps")
  .update({
    lark_open_id: ETHAN_OPEN_ID,
    lark_email: null, // Lark didn't surface email; that's fine
    // Update name to canonical Lark name (per fc59117 the Lark display
    // name wins). Existing row had "Ethan" (English); Lark says 曹鸿宇泽.
    name: "曹鸿宇泽",
    sender_name: "曹鸿宇泽",
    // Keep wechat_id from the new pending row if rep_id=3 didn't have one
    wechat_id: "hnyhc5",
  })
  .eq("id", ETHAN_REP_ID);
if (bindErr) {
  console.error("Bind failed:", bindErr.message);
  process.exit(1);
}
console.log(`✅ Bound rep_id=${ETHAN_REP_ID} ↔ open_id ${ETHAN_OPEN_ID}; updated name → 曹鸿宇泽`);

// Mark the pending row resolved (status='approved' is the closest fit;
// 'merged_into_existing' would be more accurate but isn't a known status).
const { error: pErr } = await sb
  .from("pending_onboarding")
  .update({
    status: "approved",
    decided_by_rep: 5, // admin
    decided_at: new Date().toISOString(),
  })
  .eq("id", PENDING_ID);
if (pErr) {
  console.error("pending_onboarding update failed:", pErr.message);
  process.exit(1);
}
console.log("✅ pending_onboarding marked approved");

console.log("\nDone. Ethan can DM Leon now and Leon will recognize him as rep_id=3.");
console.log("His login: ethan@compute.miracleplus.com + whatever password is already on rep_id=3.");
console.log("If he doesn't know that password, admin needs to reset it (he set a NEW password during onboarding but it was lost when the email collision broke the provisioning).");
