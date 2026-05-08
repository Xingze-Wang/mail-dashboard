/**
 * Synthesize a Lark card.action.trigger event and POST it to the
 * production /api/lark/webhook. Verifies the WebHook fallback path
 * (NOT the long-conn worker — that runs on the user's machine and is
 * unreachable from CI/CLI).
 *
 * Sequence:
 *   1. Insert a TEST_SYNTH_* pending_onboarding row (status=in_progress,
 *      step=awaiting_admin)
 *   2. Forge a card.action.trigger payload with action.value =
 *      { onboarding_action: "deny", pending_id: ... } and
 *      operator.open_id = admin's real open_id
 *   3. POST to https://qiji-pipeline.vercel.app/api/lark/webhook
 *   4. Wait 5s for after() to drain
 *   5. Re-read the pending row — if status='denied', the handler
 *      reached production code and worked. Otherwise diagnose.
 *
 * Per memory feedback_test_yourself.md, this lets us verify the
 * onboarding card-action handler without asking the user to click.
 */
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

console.log("Step 1: insert test pending row...");
const TEST_OPEN_ID = `TEST_SYNTH_${Date.now()}`;
const { data: pending, error: pErr } = await sb
  .from("pending_onboarding")
  .insert({
    lark_open_id: TEST_OPEN_ID,
    lark_name: "(synth) deny test",
    step: "awaiting_admin",
    claimed_name: "(synth)",
    claimed_email: "synth_test@compute.miracleplus.com",
    claimed_wechat: "TEST_synth",
    claimed_role: "sales",
    password_hash: "$2b$10$placeholder.placeholder.placeholder.placeholder.placeholder.aa",
    status: "in_progress",
  })
  .select("id, status")
  .single();
if (pErr) { console.error("FAIL:", pErr.message); process.exit(1); }
console.log(`  pending_id=${pending.id} status=${pending.status}`);

console.log("\nStep 2: get admin's real lark_open_id...");
const { data: admin } = await sb
  .from("sales_reps")
  .select("lark_open_id")
  .eq("id", 5)
  .maybeSingle();
const adminOpenId = admin?.lark_open_id;
if (!adminOpenId) { console.error("admin has no lark_open_id"); process.exit(1); }
console.log(`  admin_open_id=${adminOpenId.slice(0, 20)}...`);

console.log("\nStep 3: synthesize + POST card.action.trigger event...");
const payload = {
  schema: "2.0",
  header: {
    event_id: `synth-${Date.now()}`,
    event_type: "card.action.trigger",
    create_time: String(Date.now()),
    token: "synth",
    app_id: "synth",
    tenant_key: "synth",
  },
  event: {
    operator: { open_id: adminOpenId, tenant_key: "synth" },
    token: "synth",
    action: {
      tag: "button",
      value: { onboarding_action: "deny", pending_id: pending.id },
    },
    host: "im_message",
  },
};

let res, respText;
try {
  res = await fetch("https://qiji-pipeline.vercel.app/api/lark/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });
  respText = await res.text();
} catch (e) {
  console.error(`  network error: ${e.message}`);
  console.error(`  (likely Vercel edge rate-limit on this IP — try from a different host)`);
  // Still proceed to clean up the pending row even on network failure.
  await sb.from("pending_onboarding").delete().eq("id", pending.id);
  console.log(`  cleaned up pending row ${pending.id}`);
  process.exit(2);
}
console.log(`  HTTP ${res.status}: ${respText.slice(0, 200)}`);

console.log("\nStep 4: wait 6s for after() to drain...");
await new Promise((r) => setTimeout(r, 6000));

console.log("\nStep 5: re-read pending row...");
const { data: post } = await sb
  .from("pending_onboarding")
  .select("id, status, decided_at, decided_by_rep")
  .eq("id", pending.id)
  .maybeSingle();
console.log(`  post-state: status=${post?.status} decided_by=${post?.decided_by_rep ?? "null"} at=${post?.decided_at ?? "null"}`);

if (post?.status === "denied") {
  console.log("\n🎉 PASS — webhook + processOnboardingCardAction round-trip works.");
  console.log("   Production code path is HEALTHY for HTTP fallback.");
  console.log("   So if Lark cards still fail in real Lark client, it's worker-side, not code.");
} else if (post?.status === "in_progress") {
  console.log("\n❌ FAIL — pending row didn't transition.");
  console.log("   Either: (a) signature verify rejected (LARK_ENCRYPT_KEY set?),");
  console.log("           (b) handler errored silently in after()");
  console.log("   Check Vercel function logs for /api/lark/webhook to see why.");
} else {
  console.log(`\n⚠️ UNEXPECTED state: ${post?.status}`);
}

console.log("\nCleanup: deleting test pending row...");
await sb.from("pending_onboarding").delete().eq("id", pending.id);
console.log("  done.");
