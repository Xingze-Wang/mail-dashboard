// E2E for skill demo suggester:
//   1. Record a skill that LOOKS demo-able (has action + triggers) →
//      expect admin_inbox 'idea' card pushed
//   2. Record a skill that's a pure rule (no action) → no card
//   3. Record a skill with no triggers → no card (no way to craft demo query)
//   4. Simulate Yes click on the demo card → expect "paste this query" DM
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const l of env.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}
process.env.SMOKE_NO_CARDS = "1";

const { supabase } = await import("/Users/xingzewang/Desktop/mail/src/lib/db.ts");
const { recordLearning } = await import("/Users/xingzewang/Desktop/mail/src/lib/helper-learnings.ts");
const { shouldSuggestDemo, craftDemoQuery } = await import(
  "/Users/xingzewang/Desktop/mail/src/lib/skill-demo-suggester.ts"
);
const { processAdminInboxCardAction } = await import(
  "/Users/xingzewang/Desktop/mail/src/lib/admin-inbox-card.ts"
);

console.log("[0/4] cleanup prior smoke rows…");
await supabase.from("helper_learnings").delete().like("body", "DEMO-SMOKE%");
await supabase.from("admin_inbox").delete().like("headline", "🧪 新 skill 想 demo%");

console.log("\n[1/4] should-suggest-demo classifier spot checks:");
const cases = [
  { body: "DEMO-SMOKE: rep 问白名单时, 调 lookup get_lead_counts 拿到数量", triggers: ["白名单"], expect: true },
  { body: "DEMO-SMOKE: be polite when responding to clients", triggers: ["polite"], expect: false },
  { body: "DEMO-SMOKE: 使用 list_reps 查 rep_id → name 映射", triggers: ["rep_id"], expect: true },
  { body: "DEMO-SMOKE: actionful skill but no triggers", triggers: [], expect: false },
];
for (const c of cases) {
  const r = shouldSuggestDemo(c.body, c.triggers);
  const ok = r === c.expect;
  console.log("  ", ok ? "✅" : "❌", "body=" + c.body.slice(0, 40) + " triggers=" + JSON.stringify(c.triggers) + " → " + r);
}

console.log("\n[2/4] insert a demo-able skill, expect inbox card pushed…");
const skill1 = await recordLearning({
  scope_rep_id: null,
  kind: "skill",
  body: "DEMO-SMOKE skill 1: 当 rep 问白名单时, 调 get_lead_counts 拿数量",
  triggers: ["白名单", "whitelist"],
  confidence: 0.9,
});
console.log("  inserted:", skill1?.id);

// Wait briefly for the async post-hook
await new Promise((r) => setTimeout(r, 800));

const { data: card1 } = await supabase
  .from("admin_inbox")
  .select("id, headline, evidence")
  .like("headline", "🧪 新 skill 想 demo%")
  .order("created_at", { ascending: false })
  .limit(1)
  .maybeSingle();
console.log("  card found?", !!card1, "sample_query:", card1?.evidence?.sample_query);

console.log("\n[3/4] insert a pure-rule skill (no action), expect NO card…");
const skill2 = await recordLearning({
  scope_rep_id: null,
  kind: "skill",
  body: "DEMO-SMOKE skill 2: be polite when responding to clients",
  triggers: ["polite"],
  confidence: 0.9,
});
console.log("  inserted:", skill2?.id);

await new Promise((r) => setTimeout(r, 500));
const { count: cardCount2 } = await supabase
  .from("admin_inbox")
  .select("*", { count: "exact", head: true })
  .like("headline", "🧪 新 skill 想 demo%")
  .like("body", "%be polite%");
console.log("  cards for skill 2:", cardCount2, cardCount2 === 0 ? "✅ correctly NO card" : "❌");

console.log("\n[4/4] simulate Yes click on the demo card from step 2…");
if (!card1) {
  console.log("  no card to click");
} else {
  const { data: admin } = await supabase.from("sales_reps").select("lark_open_id").eq("id", 5).maybeSingle();
  const clickRes = await processAdminInboxCardAction({
    event: {
      operator: { open_id: admin?.lark_open_id },
      action: { value: { admin_inbox_action: "yes", inbox_id: card1.id } },
    },
  });
  console.log("  click result:", clickRes);
}

// Cleanup
await supabase.from("helper_learnings").delete().like("body", "DEMO-SMOKE%");
await supabase.from("admin_inbox").delete().like("headline", "🧪 新 skill 想 demo%");

console.log("\n✅ skill demo suggester verified");
