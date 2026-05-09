/**
 * Verify the Lark webhook end-to-end using the Vercel Protection
 * Bypass token. Same flow as synth-card-action.mjs but adds the
 * x-vercel-protection-bypass header so the WAF lets us through.
 *
 * What this proves: the onboarding card-action handler code is
 * healthy. Whatever Lark sees externally is a separate WAF/IP issue,
 * not a code issue.
 */
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const BYPASS = "w0sh4eUwIoApjCrE5zuGtV7hGeuf906v";

const TEST_OPEN_ID = `TEST_BYPASS_${Date.now()}`;
const { data: pending, error } = await sb
  .from("pending_onboarding")
  .insert({
    lark_open_id: TEST_OPEN_ID,
    lark_name: "(bypass test)",
    step: "awaiting_admin",
    claimed_name: "(bypass)",
    claimed_email: "test_bypass@compute.miracleplus.com",
    claimed_wechat: "TEST_bypass",
    claimed_role: "sales",
    password_hash: "$2b$10$placeholder.placeholder.placeholder.placeholder.placeholder.aa",
    status: "in_progress",
  })
  .select("id")
  .single();
if (error) { console.error("FAIL:", error.message); process.exit(1); }
console.log(`pending_id=${pending.id}`);

const { data: admin } = await sb
  .from("sales_reps")
  .select("lark_open_id")
  .eq("id", 5)
  .maybeSingle();
const adminOpenId = admin?.lark_open_id;
if (!adminOpenId) { console.error("admin has no lark_open_id"); process.exit(1); }

const payload = {
  schema: "2.0",
  header: {
    event_id: `bypass-${Date.now()}`,
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

// Belt + suspenders: query param AND header. Vercel docs say either
// works; query param is sometimes the only one that survives all
// edge layers when the WAF/challenge is in the way.
const url = `https://calistamind.com/api/lark/webhook?x-vercel-protection-bypass=${encodeURIComponent(BYPASS)}&x-vercel-set-bypass-cookie=true`;
const res = await fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-vercel-protection-bypass": BYPASS,
    "x-vercel-set-bypass-cookie": "true",
  },
  body: JSON.stringify(payload),
  signal: AbortSignal.timeout(20_000),
});
console.log(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

await new Promise((r) => setTimeout(r, 6000));

const { data: post } = await sb
  .from("pending_onboarding")
  .select("status, decided_at, decided_by_rep")
  .eq("id", pending.id)
  .maybeSingle();
console.log(`post-state: status=${post?.status} decided_by=${post?.decided_by_rep ?? "null"}`);

if (post?.status === "denied") {
  console.log("\n🎉 PASS — webhook + handler round-trip works on calistamind via bypass.");
} else {
  console.log("\n❌ FAIL — pending row didn't transition.");
}
await sb.from("pending_onboarding").delete().eq("id", pending.id);
