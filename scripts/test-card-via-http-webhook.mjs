/**
 * Synthetic test of the card-action handler by POSTing a forged
 * card.action.trigger event directly to the HTTP webhook. This bypasses
 * the long-conn worker entirely — testing the SAME shared
 * processOnboardingCardAction code, but from the HTTP path.
 *
 * Why this exists: per memory feedback_test_yourself.md, scripted
 * verification > "click the button and tell me." This lets me test
 * the action-handling code without needing the user to interact with
 * Lark at all.
 *
 * Sequence:
 *   1. Insert a TEST_HTTP_* pending_onboarding row in awaiting_admin
 *   2. POST a synthesized card.action.trigger event to /api/lark/webhook
 *      with action.value = { onboarding_action: "deny", pending_id: ... }
 *      The operator open_id is set to admin's REAL open_id so the
 *      senderIsAdmin check passes inside processOnboardingCardAction.
 *   3. Wait 2-3s for after() to finish (the webhook returns 200 ASAP
 *      and processes async)
 *   4. Re-read the pending row — if status='denied', the handler
 *      worked. If status still 'in_progress', handler didn't fire.
 *
 * We pick "deny" not "approve" so the handler doesn't try to insert
 * a sales_reps row or DM the (fake) candidate.
 */
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

// Step 1: insert a test pending row.
const TEST_OPEN_ID = `TEST_HTTP_${Date.now()}`;
const { data: pending, error: pErr } = await sb
  .from("pending_onboarding")
  .insert({
    lark_open_id: TEST_OPEN_ID,
    lark_name: "(HTTP test) deny path",
    step: "awaiting_admin",
    claimed_name: "(HTTP test)",
    claimed_email: "test_http_check@compute.miracleplus.com",
    claimed_wechat: "TEST_http",
    claimed_role: "sales",
    password_hash: "$2b$10$placeholder.placeholder.placeholder.placeholder.placeholder.aa",
    status: "in_progress",
  })
  .select("id, status")
  .single();
if (pErr) {
  console.error("pending insert failed:", pErr.message);
  process.exit(1);
}
console.log(`✅ Created pending row id=${pending.id} status=${pending.status}`);

// Step 2: get admin's real open_id (so senderIsAdmin passes).
const { data: admin } = await sb
  .from("sales_reps")
  .select("lark_open_id")
  .eq("id", 5)
  .maybeSingle();
const adminOpenId = admin?.lark_open_id;
if (!adminOpenId) {
  console.error("admin (rep_id=5) has no lark_open_id");
  process.exit(1);
}

// Step 3: forge the event payload as Lark would send it.
// Schema: { schema: "2.0", header: {...}, event: { operator, action, ... } }
const payload = {
  schema: "2.0",
  header: {
    event_id: `synthetic-test-${Date.now()}`,
    event_type: "card.action.trigger",
    create_time: String(Date.now()),
    token: "synthetic",
    app_id: "synthetic",
    tenant_key: "synthetic",
  },
  event: {
    operator: { open_id: adminOpenId, tenant_key: "synthetic" },
    token: "synthetic",
    action: {
      tag: "button",
      value: {
        onboarding_action: "deny",
        pending_id: pending.id,
      },
    },
    host: "im_message",
  },
};

const url = "https://calistamind.com/api/lark/webhook";
console.log(`Posting synthetic card.action.trigger to ${url}...`);
const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
const respText = await res.text();
console.log(`  HTTP ${res.status}: ${respText.slice(0, 200)}`);

if (!res.ok) {
  console.error("Webhook returned non-2xx — handler didn't even start");
  process.exit(1);
}

// Step 4: wait for after() to finish, then check pending row state.
console.log("Waiting 4s for after() to flush...");
await new Promise((r) => setTimeout(r, 4000));

const { data: postPending } = await sb
  .from("pending_onboarding")
  .select("id, status, decided_at, decided_by_rep")
  .eq("id", pending.id)
  .maybeSingle();

console.log(`\nPost-call pending state: status=${postPending?.status} decided_by=${postPending?.decided_by_rep} at=${postPending?.decided_at}`);

if (postPending?.status === "denied") {
  console.log("\n🎉 PASS — processOnboardingCardAction fired and handled deny correctly.");
  console.log("   So the bug is NOT in the action handler. It's in long-conn worker dispatch.");
} else {
  console.log("\n❌ FAIL — pending row state didn't change.");
  console.log("   The HTTP webhook either didn't run the handler, or the handler errored silently.");
  console.log("   Likely cause: signature verify rejection, or middleware blocking.");
}

// Clean up the test row.
await sb.from("pending_onboarding").delete().eq("id", pending.id);
console.log("\nCleaned up test pending row.");
