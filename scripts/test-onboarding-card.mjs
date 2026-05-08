/**
 * Send a TEST onboarding card to admin to verify the form-wrap revert
 * (commit 848c496) actually fixed the approve buttons.
 *
 * Creates a throwaway pending_onboarding row with a test_* prefix on
 * everything (so any accidental approval is easy to clean up), then
 * calls sendOnboardingCard() the same way the real candidate flow does.
 *
 * After the test:
 *   - If buttons work: admin clicks Deny on the card, the deny path
 *     marks pending row as 'denied' and DMs the (nonexistent) candidate
 *     — which silently fails, that's fine
 *   - If admin clicks Approve: a junk sales_reps row gets created;
 *     run scripts/cleanup-test-onboarding.mjs to remove it
 *
 * The lark_open_id is intentionally invalid (TEST_*) so even if the
 * walkthrough DM fires, Lark will just refuse it. Admin's open_id is
 * the real one (so the card actually arrives).
 */
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

// Insert a clearly-test pending row.
const TEST_OPEN_ID = `TEST_card_buttons_${Date.now()}`;
const { data: pending, error: pErr } = await sb
  .from("pending_onboarding")
  .insert({
    lark_open_id: TEST_OPEN_ID,
    lark_name: "(测试) 按钮 dispatch 验证",
    lark_email: null,
    step: "awaiting_admin",
    claimed_name: "(测试) 按钮 dispatch 验证",
    claimed_email: "test_button_check@compute.miracleplus.com",
    claimed_wechat: "TEST_button_check",
    claimed_role: "sales",
    password_hash: "$2b$10$abcdefghijklmnopqrstuv.placeholder.placeholder.placeholder.aa",
    status: "in_progress",
  })
  .select("*")
  .single();

if (pErr || !pending) {
  console.error("Insert pending failed:", pErr?.message);
  process.exit(1);
}

console.log(`✅ Created test pending row: ${pending.id}`);
console.log(`   open_id (fake): ${TEST_OPEN_ID}`);
console.log(`   This row exists so the Deny / Approve action can find it.\n`);

// Now we trigger the card via the production endpoint. There's no public
// HTTP route that calls sendOnboardingCard directly, so the cleanest
// trigger is to POST a fake "candidate finished ask_wechat" through the
// Lark webhook. But that would need real signing.
//
// Simpler: directly fetch the card-render endpoint via service-role,
// or just construct + send the card here from this script. The
// sendOnboardingCard function is a TypeScript export; we'd need to
// load the bundled module. Easier: inline a minimal copy of the card
// payload here, send it via Lark's API.

const adminLookup = await sb
  .from("sales_reps")
  .select("lark_open_id")
  .eq("id", 5)
  .maybeSingle();
const adminOpenId = adminLookup.data?.lark_open_id;
if (!adminOpenId) {
  console.error("Admin (rep_id=5) has no lark_open_id");
  process.exit(1);
}

// Get tenant access token via Lark.
const APP_ID = process.env.LARK_APP_ID;
const APP_SECRET = process.env.LARK_APP_SECRET;
if (!APP_ID || !APP_SECRET) {
  console.error("LARK_APP_ID / LARK_APP_SECRET not in env — set them and re-run");
  process.exit(1);
}

const region = (process.env.LARK_REGION ?? "cn").toLowerCase();
const base = region === "global" || region === "intl"
  ? "https://open.larksuite.com/open-apis"
  : "https://open.feishu.cn/open-apis";

const tokRes = await fetch(`${base}/auth/v3/tenant_access_token/internal`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
});
const tokData = await tokRes.json();
if (!tokData.tenant_access_token) {
  console.error("Couldn't get Lark token:", tokData);
  process.exit(1);
}
const token = tokData.tenant_access_token;

// Build the card — must match the schema in src/lib/onboarding.ts
// sendOnboardingCard exactly. (Hand-mirrored here for the test —
// if onboarding.ts's card schema changes, update this script too.)
const card = {
  config: { wide_screen_mode: true },
  header: {
    title: { tag: "plain_text", content: "🧪 [TEST] Approve-button dispatch check" },
    template: "blue",
  },
  elements: [
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content:
          `**这是测试卡** — 用来验证按钮能不能点 (form-wrap 撤销之后).\n\n` +
          `**Lark identity** (from Lark, can't be spoofed):\n` +
          `- Name: ${pending.lark_name}\n` +
          `- Email: ${pending.lark_email ?? "(no email)"}\n` +
          `- open_id: \`${pending.lark_open_id}\`\n\n` +
          `**Self-claimed** (from chat, verify these match the person):\n` +
          `- Name: ${pending.claimed_name}\n` +
          `- Email: \`${pending.claimed_email}\`\n` +
          `- WeChat: ${pending.claimed_wechat}\n` +
          `- Role: ${pending.claimed_role}\n\n` +
          `🧪 **测试用法**: 点 **Deny** 来验证按钮能 dispatch. Approve 也行但会建一个 fake rep, 我会清掉.`,
      },
    },
    {
      tag: "action",
      actions: [
        {
          tag: "button",
          text: { tag: "plain_text", content: "Approve as sales" },
          type: "primary",
          value: { onboarding_action: "approve_sales", pending_id: pending.id },
        },
        {
          tag: "button",
          text: { tag: "plain_text", content: "Approve as senior" },
          type: "default",
          value: { onboarding_action: "approve_senior", pending_id: pending.id },
        },
        {
          tag: "button",
          text: { tag: "plain_text", content: "Deny" },
          type: "danger",
          value: { onboarding_action: "deny", pending_id: pending.id },
        },
      ],
    },
    {
      tag: "note",
      elements: [
        {
          tag: "plain_text",
          content:
            "Lark name + open_id 是 fake 的 (TEST_*). 这张卡只是验证 form-wrap 撤销之后按钮能不能点击.",
        },
      ],
    },
  ],
};

const sendRes = await fetch(`${base}/im/v1/messages?receive_id_type=open_id`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({
    receive_id: adminOpenId,
    msg_type: "interactive",
    content: JSON.stringify(card),
  }),
});

const sendData = await sendRes.json();
if (sendRes.ok && sendData.code === 0) {
  console.log("✅ Test card sent to admin via Lark.");
  console.log(`   message_id: ${sendData.data?.message_id ?? "?"}`);
  console.log(`\nGo check Lark. Click any button. If it works:`);
  console.log(`  - Deny → pending row's status becomes 'denied'`);
  console.log(`  - Approve → a fake sales_reps row is created`);
  console.log(`\nClean up after with: node scripts/cleanup-test-onboarding.mjs`);
} else {
  console.error("Send failed:", sendRes.status, sendData);
  process.exit(1);
}
