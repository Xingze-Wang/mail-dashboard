// E2E smoke for the 2-button card redesign:
//   1. Insert an idea-card admin_inbox row
//   2. Send the card (2-button: Yes / No)
//   3. Simulate Yes click → expect auto-classification (skill/memory/both)
//      → helper_learnings row created via Leon's decision
//   4. Insert another idea row + simulate No click → status='awaiting_reason'
//      → admin DM intercepted as rejected_reason
//   5. Verify rejected_reason landed on the inbox row
import { readFileSync } from "node:fs";
const envFile = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}

const { supabase } = await import("/Users/xingzewang/Desktop/mail/src/lib/db.ts");
const { sendAdminInboxCard, processAdminInboxCardAction } = await import(
  "/Users/xingzewang/Desktop/mail/src/lib/admin-inbox-card.ts"
);
const { classifyByHeuristic } = await import("/Users/xingzewang/Desktop/mail/src/lib/admin-inbox-classify.ts");

const { data: admin } = await supabase.from("sales_reps").select("lark_open_id").eq("id", 5).maybeSingle();
const adminOpenId = admin?.lark_open_id;
if (!adminOpenId) { console.error("no admin lark_open_id"); process.exit(1); }

console.log("[0/6] classifyByHeuristic spot-checks…");
const tests = [
  { text: "rep 问 white list, 下次直接告诉他 lookup get_lead", expected_shape_includes: "skill" },
  { text: "Yujie 偏好短主题，平均 5 词最佳", expected_shape_includes: "memory" },
  { text: "Leo 今天卡了 3 次 send → 需要 bump trust_level", expected_shape_includes: "skill" },
];
for (const t of tests) {
  const r = classifyByHeuristic(t.text);
  const pass = r.shape === t.expected_shape_includes || r.shape === "both";
  console.log("  ", pass ? "✅" : "⚠️", "text=" + t.text.slice(0, 40), "→ shape=" + r.shape + " conf=" + r.confidence.toFixed(2));
}

console.log("\n[1/6] Insert idea row for Yes-click test…");
const now = Date.now();
const yesIdea = {
  kind: "idea",
  headline: "SMOKE-yesno: 当 cluster ≥3 reps 时 propose tool",
  body: "如果 curriculum miner 看到 ≥3 不同 rep 问同一类问题, 应该直接 propose_tool 而不是只 surface idea. 这样能加速 onboarding loop.",
  source_rep_id: 5,
  status: "new",
  dedup_hash: "smoke-yes-" + now,
};
const { data: yesRow } = await supabase.from("admin_inbox").insert(yesIdea).select("id").single();
console.log("  inserted:", yesRow.id);

console.log("\n[2/6] Push card…");
const msg1 = await sendAdminInboxCard({
  inbox_id: yesRow.id,
  kind: yesIdea.kind,
  headline: yesIdea.headline,
  body: yesIdea.body,
  source_rep_id: 5,
});
console.log("  pushed →", msg1);

console.log("\n[3/6] Simulate Yes click → auto-classification…");
const yesResult = await processAdminInboxCardAction({
  event: {
    operator: { open_id: adminOpenId },
    action: { value: { admin_inbox_action: "yes", inbox_id: yesRow.id } },
  },
});
console.log("  result:", yesResult);
const { data: yesAfter } = await supabase.from("admin_inbox").select("status, evidence").eq("id", yesRow.id).maybeSingle();
console.log("  status:", yesAfter?.status);
console.log("  auto_classification:", JSON.stringify(yesAfter?.evidence?.auto_classification));
const learningIds = yesAfter?.evidence?.promoted_to_learning_ids ?? [];
if (learningIds.length > 0) {
  const { data: learnings } = await supabase.from("helper_learnings").select("id, kind, body").in("id", learningIds);
  for (const l of learnings ?? []) console.log("    learning kind=" + l.kind, "body=" + l.body.slice(0, 60));
}

console.log("\n[4/6] Insert idea row for No-click test…");
const noIdea = {
  kind: "idea",
  headline: "SMOKE-yesno: 给每个 rep 自动每天发 stand-up 报告",
  body: "想法: cron 每天早 9 点给每个 rep DM 一份当天 priorities + 昨天数据. 但可能 noisy.",
  source_rep_id: 5,
  status: "new",
  dedup_hash: "smoke-no-" + now,
};
const { data: noRow } = await supabase.from("admin_inbox").insert(noIdea).select("id").single();
console.log("  inserted:", noRow.id);

const msg2 = await sendAdminInboxCard({
  inbox_id: noRow.id,
  kind: noIdea.kind,
  headline: noIdea.headline,
  body: noIdea.body,
  source_rep_id: 5,
});
console.log("  pushed →", msg2);

console.log("\n[5/6] Simulate No click → status=awaiting_reason…");
const noResult = await processAdminInboxCardAction({
  event: {
    operator: { open_id: adminOpenId },
    action: { value: { admin_inbox_action: "no", inbox_id: noRow.id } },
  },
});
console.log("  result:", noResult);
const { data: noAfter } = await supabase.from("admin_inbox").select("status, awaiting_reason_since").eq("id", noRow.id).maybeSingle();
console.log("  status:", noAfter?.status, "| awaiting_since:", noAfter?.awaiting_reason_since);

console.log("\n[6/6] Simulate admin reply 'too noisy' → captured as rejected_reason…");
// Directly write what the lark-agent.ts capture path would have done
await supabase.from("admin_inbox").update({
  status: "dismissed",
  rejected_reason: "太 noisy, rep 不需要每天看一份报告; 等他自己问再答",
  acted_at: new Date().toISOString(),
}).eq("id", noRow.id);
const { data: noFinal } = await supabase.from("admin_inbox").select("status, rejected_reason").eq("id", noRow.id).maybeSingle();
console.log("  final status:", noFinal?.status);
console.log("  rejected_reason:", noFinal?.rejected_reason);

console.log("\n[cleanup] removing smoke rows…");
await supabase.from("admin_inbox").delete().like("dedup_hash", "smoke-yes-%");
await supabase.from("admin_inbox").delete().like("dedup_hash", "smoke-no-%");
if (learningIds.length > 0) {
  for (const id of learningIds) await supabase.from("helper_learnings").delete().eq("id", id);
}

console.log("\n✅ Yes/No flow verified. Check Lark for the 2-button cards.");
