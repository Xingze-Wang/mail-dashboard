// Verify the auto-vs-review pause behavior in guided_tasks:
//   1. Plan with [auto, review, auto, review] steps
//   2. Approve → status=running
//   3. record step 0 (auto) → next is 'review' → should be paused, awaiting_step_ack=1
//   4. ack continue → step 1 done (review) → next is 'auto' → should be RUNNING, awaiting_step_ack=null
//   5. record step 2 (auto) → next is 'review' → paused at 3
//   6. ack continue → record step 3 (last) → completed
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const l of env.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}
process.env.SMOKE_NO_CARDS = "1";

const { supabase } = await import("/Users/xingzewang/Desktop/mail/src/lib/db.ts");
const { proposeGuidedTask, recordStepResult, ackGuidedStep, getGuidedTask, approveGuidedTaskPlan } = await import(
  "/Users/xingzewang/Desktop/mail/src/lib/guided-tasks.ts"
);

console.log("[1/6] propose 4-step plan with mixed risk_level…");
const p = await proposeGuidedTask({
  goal: "SMOKE-RISK: mixed auto/review steps",
  steps: [
    { intent: "Step 0: lookup leads (auto)", risk_level: "auto" },
    { intent: "Step 1: write to db (review)", risk_level: "review" },
    { intent: "Step 2: lookup again (auto)", risk_level: "auto" },
    { intent: "Step 3: dm someone (review)", risk_level: "review" },
  ],
  proposed_by_rep_id: 5,
});
console.log("  →", p);
if (!p.ok) process.exit(1);

console.log("\n[2/6] approve plan → running…");
await approveGuidedTaskPlan({ task_id: p.id, approved_by_rep_id: 5 });
let t = await getGuidedTask(p.id);
console.log("  status:", t.status, "awaiting:", t.awaiting_step_ack);

console.log("\n[3/6] record step 0 (auto). Next is review → should PAUSE…");
const r0 = await recordStepResult({ task_id: p.id, step_index: 0, result: { ok: true, summary: "looked up 41 leads" } });
console.log("  →", r0);
t = await getGuidedTask(p.id);
console.log("  status:", t.status, "awaiting:", t.awaiting_step_ack, "current_step:", t.current_step);

console.log("\n[4/6] ack continue → step 1. Then record step 1. Next is auto → should AUTO-RUN…");
await ackGuidedStep({ task_id: p.id, ack: "continue" });
const r1 = await recordStepResult({ task_id: p.id, step_index: 1, result: { ok: true, summary: "wrote 1 row" } });
console.log("  →", r1);
t = await getGuidedTask(p.id);
console.log("  status:", t.status, "awaiting:", t.awaiting_step_ack, "current_step:", t.current_step);

console.log("\n[5/6] record step 2 (auto). Next is review → should PAUSE…");
const r2 = await recordStepResult({ task_id: p.id, step_index: 2, result: { ok: true, summary: "looked up again" } });
console.log("  →", r2);
t = await getGuidedTask(p.id);
console.log("  status:", t.status, "awaiting:", t.awaiting_step_ack);

console.log("\n[6/6] ack continue → record step 3 (last) → COMPLETED…");
await ackGuidedStep({ task_id: p.id, ack: "continue" });
const r3 = await recordStepResult({ task_id: p.id, step_index: 3, result: { ok: true, summary: "DM'd Yujie" } });
console.log("  →", r3);
t = await getGuidedTask(p.id);
console.log("  final status:", t.status, "step_results:", t.step_results.length);

// Cleanup
await supabase.from("guided_tasks").delete().eq("id", p.id);
if (p.inbox_id) await supabase.from("admin_inbox").delete().eq("id", p.inbox_id);

const ok =
  r0.needs_ack === true &&
  r1.needs_ack === false &&
  r2.needs_ack === true &&
  r3.done === true &&
  t.status === "completed";
console.log(ok ? "\n✅ risk-aware step gating verified" : "\n⚠️ some checks failed");
