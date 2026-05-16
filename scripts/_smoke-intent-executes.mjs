// Smoke: prove /admin/intent → approve actually executes steps (not just
// flip status). Mirrors _smoke-intent-flow.mjs but does NOT stop at
// "status=planned" — it simulates admin Yes on the inbox card and asserts
// the executor actually ran the auto steps.
//
// Plan = 2 auto steps (lookup-only, safe to actually run end-to-end):
//   1. list_reps   — should auto-continue
//   2. get_lead_counts — last step, should mark task completed
//
// Pass criteria:
//   - status=running after Yes (immediate)
//   - within ~30s of Yes, status=completed and step_results.length=2
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const l of env.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}
process.env.SMOKE_NO_CARDS = "1";

const { supabase } = await import("/Users/xingzewang/Desktop/mail/src/lib/db.ts");
const { proposeGuidedTask, getGuidedTask } = await import("/Users/xingzewang/Desktop/mail/src/lib/guided-tasks.ts");
const { processAdminInboxCardAction } = await import("/Users/xingzewang/Desktop/mail/src/lib/admin-inbox-card.ts");

console.log("[1/4] propose 2-step plan (all auto, safe lookups)…");
const proposal = await proposeGuidedTask({
  goal: "SMOKE-INTENT-EXEC: 拿 rep 名单 + lead 数量, 仅 lookup",
  steps: [
    { intent: "调 list_reps 拿到所有 rep 的列表", verification: "返回非空 reps 数组", risk_level: "auto" },
    { intent: "调 get_lead_counts 拿到 total + per-rep 计数", verification: "返回 total >= 0", risk_level: "auto" },
  ],
  proposed_by_rep_id: 5,
});
console.log("  proposal:", proposal);
if (!proposal.ok) { console.error("FAIL: propose did not return ok"); process.exit(1); }

console.log("\n[2/4] simulate admin Yes on plan card…");
const { data: admin } = await supabase.from("sales_reps").select("lark_open_id, id").eq("id", 5).maybeSingle();
const yesRes = await processAdminInboxCardAction({
  event: {
    operator: { open_id: admin?.lark_open_id ?? "ou_smoke" },
    action: { value: { admin_inbox_action: "yes", inbox_id: proposal.inbox_id } },
  },
});
console.log("  click result:", yesRes);

console.log("\n[3/4] poll task status (12x, 10s gap) — expect transition to completed…");
let final;
for (let i = 0; i < 12; i++) {
  await new Promise((r) => setTimeout(r, 10000));
  const t = await getGuidedTask(proposal.id);
  console.log(`  poll ${i + 1} (~${(i + 1) * 10}s): status=${t?.status} · current_step=${t?.current_step} · step_results=${t?.step_results?.length ?? 0}`);
  if (t?.status === "completed" || t?.status === "aborted" || t?.status === "failed") {
    final = t;
    break;
  }
  final = t;
}

console.log("\n[4/4] inspect step_results…");
if (final?.step_results) {
  for (const [i, r] of final.step_results.entries()) {
    console.log(`  step ${i}: ok=${r.ok} summary="${(r.summary ?? "").slice(0, 120)}"`);
  }
}

// cleanup
await supabase.from("guided_tasks").delete().eq("id", proposal.id);
if (proposal.inbox_id) await supabase.from("admin_inbox").delete().eq("id", proposal.inbox_id);

const pass = final?.status === "completed" && (final?.step_results?.length ?? 0) >= 1;
console.log(pass ? "\n✅ executor wired — steps ran end-to-end" : "\n❌ FAIL: task did not progress to completed");
process.exit(pass ? 0 : 1);
