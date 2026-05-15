// E2E for guided_tasks (OpenClaw-style multi-step):
//   1. proposeGuidedTask with 3 steps → admin_inbox card
//   2. simulate admin Yes → status=running
//   3. record step 0 → status=paused, DM sent (SMOKE_NO_CARDS=1 suppresses)
//   4. ack 'continue' → status=running
//   5. record step 1 → paused
//   6. ack 'continue' → running
//   7. record step 2 (last) → status=completed
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const l of env.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}
process.env.SMOKE_NO_CARDS = "1";

const { supabase } = await import("/Users/xingzewang/Desktop/mail/src/lib/db.ts");
const { processAdminInboxCardAction } = await import(
  "/Users/xingzewang/Desktop/mail/src/lib/admin-inbox-card.ts"
);
const { proposeGuidedTask, recordStepResult, ackGuidedStep, getGuidedTask } = await import(
  "/Users/xingzewang/Desktop/mail/src/lib/guided-tasks.ts"
);

console.log("[1/7] propose 3-step plan…");
const proposal = await proposeGuidedTask({
  goal: "SMOKE-GUIDED: 测试多步任务 loop 是否能跑通",
  steps: [
    { intent: "Step 0: lookup get_lead_counts 拿 cn 数量", verification: "返回非负整数" },
    { intent: "Step 1: 给 admin DM 这个数字" },
    { intent: "Step 2: 写一条 helper_learning 记录此次 demo" },
  ],
  proposed_by_rep_id: 5,
});
console.log("  →", proposal);
if (!proposal.ok) process.exit(1);

console.log("\n[2/7] simulate admin Yes on plan card…");
const { data: admin } = await supabase.from("sales_reps").select("lark_open_id").eq("id", 5).maybeSingle();
const yesRes = await processAdminInboxCardAction({
  event: {
    operator: { open_id: admin?.lark_open_id },
    action: { value: { admin_inbox_action: "yes", inbox_id: proposal.inbox_id } },
  },
});
console.log("  click result:", yesRes);
let t = await getGuidedTask(proposal.id);
console.log("  status:", t?.status, "current_step:", t?.current_step);

console.log("\n[3/7] record step 0 result…");
const r0 = await recordStepResult({
  task_id: proposal.id,
  step_index: 0,
  result: { ok: true, summary: "拿到 cn 数量=301", evidence: { cn_count: 301 } },
});
console.log("  →", r0);
t = await getGuidedTask(proposal.id);
console.log("  status:", t?.status, "current_step:", t?.current_step);

console.log("\n[4/7] ack continue → next step…");
const a0 = await ackGuidedStep({ task_id: proposal.id, ack: "continue" });
console.log("  →", a0);

console.log("\n[5/7] record step 1…");
const r1 = await recordStepResult({
  task_id: proposal.id,
  step_index: 1,
  result: { ok: true, summary: "已 DM admin '过去 7 天 cn=301'" },
});
console.log("  →", r1);
t = await getGuidedTask(proposal.id);
console.log("  status:", t?.status);

console.log("\n[6/7] ack continue → last step…");
await ackGuidedStep({ task_id: proposal.id, ack: "continue" });

console.log("\n[7/7] record step 2 (last) → completed…");
const r2 = await recordStepResult({
  task_id: proposal.id,
  step_index: 2,
  result: { ok: true, summary: "写入 helper_learning id=fake-uuid" },
});
console.log("  → done?", r2.done);
t = await getGuidedTask(proposal.id);
console.log("  final status:", t?.status, "step_results count:", t?.step_results?.length);

// Cleanup
await supabase.from("guided_tasks").delete().eq("id", proposal.id);
if (proposal.inbox_id) await supabase.from("admin_inbox").delete().eq("id", proposal.inbox_id);

const ok = t?.status === "completed" && t?.step_results?.length === 3 && r2.done;
console.log(ok ? "\n✅ guided_tasks loop verified" : "\n⚠️ some checks failed");
