// Smoke the full intent flow end-to-end to surface where the "running but not running" feeling comes from.
// Steps:
//   1. Call /api/admin/plan-intent (phase 1) → get plan. Time it.
//   2. Call /api/admin/plan-intent (phase 2, submit) → get task_id. Time it.
//   3. GET /api/admin/tasks/<id> → inspect status. Repeat 3x with 2.5s gap (mimics poll).
//   4. Report: at each phase, what's the status? Where's the bottleneck?
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const l of env.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}
process.env.SMOKE_NO_CARDS = "1";

const { supabase } = await import("/Users/xingzewang/Desktop/mail/src/lib/db.ts");

// Direct module calls (avoid HTTP layer — same code path Vercel runs)
const intentMod = await import("/Users/xingzewang/Desktop/mail/src/app/api/admin/plan-intent/route.ts");
const taskMod   = await import("/Users/xingzewang/Desktop/mail/src/app/api/admin/tasks/[id]/route.ts");

// Get admin's session
const { data: admin } = await supabase.from("sales_reps").select("id, name, role").eq("role", "admin").maybeSingle();
const adminRepId = admin?.id ?? 5;

// We need to mint a valid session cookie. Easiest path: hit auth helper signing the JWT
const { SignJWT } = await import("jose");
const secret = new TextEncoder().encode(process.env.AUTH_SECRET);
const token = await new SignJWT({ repId: adminRepId, role: "admin", repName: admin?.name ?? "Smoke", email: "smoke@e.com" })
  .setProtectedHeader({ alg: "HS256" })
  .setExpirationTime("1h")
  .sign(secret);
const cookieHeader = `qiji_session=${token}`;

const { NextRequest } = await import("next/server");
function makeReq(url, init = {}) {
  return new NextRequest(url, {
    ...init,
    headers: { ...(init.headers ?? {}), cookie: cookieHeader },
  });
}

console.log("\n[Phase 1] POST /api/admin/plan-intent (plan)…");
const t0 = Date.now();
const planReq = makeReq("http://localhost/api/admin/plan-intent", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ intent: "把 cn 的 strong tier lead 数一下, 然后告诉我 top 3 哪些 rep 持有" }),
});
const planRes = await intentMod.POST(planReq);
const planJ = await planRes.json();
const t1 = Date.now();
console.log(`  ${t1 - t0}ms`);
if (planJ.error) { console.error("plan err:", planJ.error); process.exit(1); }
console.log("  plan:", { goal: planJ.plan.goal, steps: planJ.plan.steps.length });
for (const s of planJ.plan.steps) {
  console.log("    -", s.risk_level ?? "review", "·", s.intent.slice(0, 70));
}

console.log("\n[Phase 2] POST /api/admin/plan-intent (submit)…");
const submitReq = makeReq("http://localhost/api/admin/plan-intent", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ intent: "smoke", submit: true, plan: planJ.plan }),
});
const submitRes = await intentMod.POST(submitReq);
const submitJ = await submitRes.json();
const t2 = Date.now();
console.log(`  ${t2 - t1}ms`);
console.log("  submit:", submitJ);
const taskId = submitJ.task_id;
if (!taskId) { console.error("no task_id"); process.exit(1); }

console.log("\n[Phase 3] Poll GET /api/admin/tasks/<id> 3x with 2.5s gap…");
for (let i = 0; i < 3; i++) {
  await new Promise((r) => setTimeout(r, i === 0 ? 0 : 2500));
  const getReq = makeReq(`http://localhost/api/admin/tasks/${taskId}`);
  const getRes = await taskMod.GET(getReq, { params: Promise.resolve({ id: taskId }) });
  const getJ = await getRes.json();
  console.log(`  poll ${i + 1}: status=${getJ.task?.status} · current_step=${getJ.task?.current_step} · awaiting_step_ack=${getJ.task?.awaiting_step_ack} · approved_at=${getJ.task?.approved_at}`);
}

console.log("\n[diagnosis]");
const { data: row } = await supabase
  .from("guided_tasks")
  .select("status, awaiting_step_ack, approved_at, current_step, inbox_id")
  .eq("id", taskId)
  .maybeSingle();
console.log("  DB state:", row);
console.log("  inbox row created?", row?.inbox_id ? "yes — admin should see Lark card or /admin/inbox row" : "no — no admin trigger to approve");
console.log("");
console.log("  EXPECTED BEHAVIOR: web page polls → shows status=planned indefinitely until admin clicks Yes on the Lark card.");
console.log("  If 'running but not running' means UI shows submitted but no progress → admin never clicked Yes (or card never landed).");
console.log("  The UI today doesn't differentiate 'waiting for admin approval' from 'running step N' — they look the same.");

// cleanup
console.log("\n[cleanup]");
await supabase.from("guided_tasks").delete().eq("id", taskId);
if (row?.inbox_id) await supabase.from("admin_inbox").delete().eq("id", row.inbox_id);
console.log("  removed task + inbox row");
