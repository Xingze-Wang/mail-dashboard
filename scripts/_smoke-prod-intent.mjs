// Smoke prod /admin/intent end-to-end by going around the auth wall:
//   1. Insert a guided_task + admin_inbox row directly (mimics proposeGuidedTask)
//   2. Synth a Lark card-action "yes" click to prod webhook → triggers
//      processAdminInboxCardAction → approveGuidedTaskPlan → executeNextGuidedStep
//   3. Poll the task — does it transition planned → running → completed?
//
// If task stays at "running" with step_results empty, executor was killed
// by Vercel and we need after() wrap.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const l of env.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}

const BYPASS = "w0sh4eUwIoApjCrE5zuGtV7hGeuf906v";
const PROD = "https://calistamind.com";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } },
);

// Build a synth 2-step guided_task: 1 lookup + 1 lookup
const steps = [
  { intent: "我会 lookup list_reps 拿到 active reps 列表", verification: "应该看到 4-6 个 rep", risk_level: "auto" },
  { intent: "我会再 lookup get_my_stats 看 rep_id=5 (admin) 的最近 14 天活动", verification: "看到 sent/conv", risk_level: "auto" },
];
const goal = "smoke-intent: list reps and admin stats";

// 1. Insert guided_task
const { data: taskRow, error: tErr } = await sb
  .from("guided_tasks")
  .insert({
    goal, constraints: null, steps,
    proposed_by_rep_id: 5,
  })
  .select("id")
  .single();
if (tErr) { console.error("task insert err:", tErr); process.exit(1); }
const taskId = taskRow.id;
console.log(`[1] inserted guided_task ${taskId}`);

// 2. Insert admin_inbox row pointing at the task
const enc = new TextEncoder();
const buf = await crypto.subtle.digest("SHA-256", enc.encode(`guided_task|${taskId}`));
const dedupHash = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
const headline = `🗺 smoke: ${goal}`;
const { data: inboxRow, error: iErr } = await sb
  .from("admin_inbox")
  .insert({
    kind: "request", headline, body: "(smoke)",
    source_rep_id: 5,
    evidence: { source: "guided_task_plan", guided_task_id: taskId, step_count: steps.length },
    dedup_hash: dedupHash,
  })
  .select("id")
  .single();
if (iErr) { console.error("inbox insert err:", iErr); process.exit(1); }
const inboxId = inboxRow.id;
console.log(`[2] inserted admin_inbox ${inboxId}`);

await sb.from("guided_tasks").update({ inbox_id: inboxId }).eq("id", taskId);

// 3. Synth Lark card-action "yes" click
const { data: admin } = await sb.from("sales_reps").select("lark_open_id").eq("id", 5).maybeSingle();
const adminOpenId = admin?.lark_open_id;
if (!adminOpenId) { console.error("admin has no lark_open_id"); process.exit(1); }
const cardEvent = {
  schema: "2.0",
  header: {
    event_id: `intent-smoke-${Date.now()}`,
    event_type: "card.action.trigger",
    create_time: String(Date.now()),
    token: "synth", app_id: "synth", tenant_key: "synth",
  },
  event: {
    operator: { open_id: adminOpenId, tenant_key: "synth" },
    token: "synth",
    action: {
      tag: "button",
      value: { admin_inbox_action: "yes", inbox_id: inboxId },
    },
    host: "im_message",
  },
};
const r3 = await fetch(`${PROD}/api/lark/webhook?x-vercel-protection-bypass=${encodeURIComponent(BYPASS)}&x-vercel-set-bypass-cookie=true`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-vercel-protection-bypass": BYPASS,
    "x-vercel-set-bypass-cookie": "true",
  },
  body: JSON.stringify(cardEvent),
  signal: AbortSignal.timeout(15_000),
});
console.log(`[3] webhook POST HTTP ${r3.status} body=${(await r3.text()).slice(0, 200)}`);

// 4. Poll task state
console.log("\n[4] Poll task (12 polls @ 5s = up to 60s)");
let final;
for (let i = 0; i < 12; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const { data: t } = await sb.from("guided_tasks").select("*").eq("id", taskId).maybeSingle();
  console.log(`  t+${(i+1)*5}s · status=${t.status} · step=${t.current_step}/${t.steps.length} · results=${t.step_results.length} · awaiting=${t.awaiting_step_ack}`);
  final = t;
  if (t.status === "completed" || t.status === "failed" || t.status === "aborted") break;
}

console.log(`\n[FINAL] status=${final.status}`);
console.log("  step_results:");
for (const r of final.step_results) console.log(`    · ok=${r.ok} summary=${(r.summary ?? "").slice(0, 150)}`);
if (final.abort_reason) console.log("  abort_reason:", final.abort_reason);

// Cleanup
await sb.from("guided_tasks").delete().eq("id", taskId);
await sb.from("admin_inbox").delete().eq("id", inboxId);
console.log("\n(cleanup done)");

// Exit signaling success vs failure
process.exit(final.status === "completed" ? 0 : 2);
