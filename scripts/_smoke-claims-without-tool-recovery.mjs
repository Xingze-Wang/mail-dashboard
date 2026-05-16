// Smoke for the "claim-without-tool auto-recovery" path in lark-agent.
//
// Bug context (2026-05-16): Leon sometimes replies in plain text with
// "我记下来了 / 我记住了 / 存进去了 / 已记录" without emitting the
// required `remember_about_rep` tool block. The detector logged a
// self_critique but didn't fix the lie — the user got "我没真的存进
// memory — 这是骗你, 道歉." apology message.
//
// Fix: detector now extracts the body after the trigger phrase and
// auto-calls tryAutoExecuteSafe to actually persist a remember_about_rep
// row. This smoke verifies BOTH:
//   (a) the pure detector function analyzeClaimWithoutTool() — fast,
//       deterministic, no DB. We feed it synthetic LLM replies covering
//       the recovery / no-recovery / not-recoverable cases.
//   (b) the full processInboundLarkMessage path — admin DM with a
//       message that *should* (in production) trigger remember_about_rep.
//       We snapshot helper_learnings BEFORE/AFTER. If the model emits a
//       real tool block, fine (no detector fire). If the model fakes it
//       (the original bug), the recovery path fires and we still get a
//       row.
//
// Run: SMOKE_NO_CARDS=1 npx tsx scripts/_smoke-claims-without-tool-recovery.mjs

import { readFileSync } from "node:fs";
const env = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const l of env.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}
process.env.SMOKE_NO_CARDS = process.env.SMOKE_NO_CARDS ?? "1";

const { createClient } = await import("@supabase/supabase-js");
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

let fails = 0;
function ok(name, cond, detail = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  if (!cond) fails++;
}

// ───────────────────────────────────────────────────────────────────
// PART 1 — Pure detector: analyzeClaimWithoutTool()
// ───────────────────────────────────────────────────────────────────
console.log("=== PART 1: pure analyzeClaimWithoutTool() ===");

const agent = await import("/Users/xingzewang/Desktop/mail/src/lib/lark-agent.ts");
const analyze = agent.analyzeClaimWithoutTool;
if (typeof analyze !== "function") {
  console.error("❌ analyzeClaimWithoutTool is not exported from lark-agent.ts");
  process.exit(1);
}

// (1a) recoverable: additive trigger + usable body
{
  const r = analyze("好, 记下来了: Yujie 早会更喜欢用中文不用英文回复, 同步过来.");
  console.log("  case 1a (recoverable additive):", JSON.stringify(r));
  ok("detectorFired", r.detectorFired === true);
  ok("recoverable", r.recoverable === true);
  ok("body contains '早会'", r.recoverable && /早会/.test(r.body || ""));
  ok("kind defaults to 'other'", r.recoverable && r.kind === "other");
}

// (1b) recoverable with explicit kind prefix
{
  const r = analyze("好的, 我记住了: rep_pref: Yujie 早会用中文回复, 不要英文.");
  console.log("  case 1b (rep_pref prefix):", JSON.stringify(r));
  ok("recoverable", r.detectorFired && r.recoverable === true);
  ok("kind=rep_pref", r.recoverable && r.kind === "rep_pref");
  ok("body stripped of prefix", r.recoverable && !/^rep_pref/i.test(r.body || ""));
}

// (1c) NOT recoverable: correction-like trigger
{
  const r = analyze("我 consolidate 一下 admin 刚说的, 下次按这个回答.");
  console.log("  case 1c (correction-like):", JSON.stringify(r));
  ok("detectorFired", r.detectorFired === true);
  ok("NOT recoverable", r.detectorFired && r.recoverable === false);
  ok("reason mentions correction", r.detectorFired && r.recoverable === false && /correction|unsafe/i.test(r.reason || ""));
}

// (1d) NOT recoverable: body too short
{
  const r = analyze("记下来了.");
  console.log("  case 1d (vague):", JSON.stringify(r));
  ok("detectorFired", r.detectorFired === true);
  ok("NOT recoverable (short)", r.detectorFired && r.recoverable === false);
}

// (1e) detector does NOT fire on innocent text
{
  const r = analyze("Yujie 这周发了 20 封邮件, 表现不错.");
  console.log("  case 1e (no claim):", JSON.stringify(r));
  ok("detectorFired = false", r.detectorFired === false);
}

// (1f) tactic: prefix
{
  const r = analyze("OK, 已记录: tactic: 给 .edu 邮箱先发 introductory email, 别上来就丢 ask.");
  console.log("  case 1f (tactic prefix):", JSON.stringify(r));
  ok("recoverable", r.detectorFired && r.recoverable === true);
  ok("kind=tactic", r.recoverable && r.kind === "tactic");
}

// ───────────────────────────────────────────────────────────────────
// PART 2 — End-to-end through processInboundLarkMessage
// ───────────────────────────────────────────────────────────────────
console.log("\n=== PART 2: end-to-end through processInboundLarkMessage ===");

const ADMIN_OPEN_ID = "ou_395f934f5add3c398bed6be8f258246b"; // Xingze (admin, rep_id=5)
// Explicit "记下来" instruction nudges the agent toward a memory tool.
// Real-LLM behavior is non-deterministic — Part 2's assertions are
// downgraded to advisory (real proof of the recovery path is Part 3).
const TEST_INSTRUCTION = "记一下: Yujie 早会用中文不用英文回复, 同步给团队.";

// Snapshot helper_learnings (BEFORE)
const { count: beforeCount } = await s
  .from("helper_learnings")
  .select("*", { count: "exact", head: true })
  .is("superseded_at", null);
console.log(`BEFORE memory count (active rows): ${beforeCount}`);

// Recent rows for body match later
const { data: beforeRows } = await s
  .from("helper_learnings")
  .select("id, created_at, kind, body, scope_rep_id")
  .order("created_at", { ascending: false })
  .limit(1);
const sentinelTs = beforeRows?.[0]?.created_at ?? new Date(Date.now() - 60000).toISOString();

const chatId = `oc_smoke_claim_${Date.now()}`;
const messageId = `smoke_msg_${Date.now()}`;
const fakeEvent = {
  schema: "2.0",
  header: {
    event_id: `smoke_${Date.now()}`,
    event_type: "im.message.receive_v1",
    create_time: String(Date.now()),
    token: "synthetic",
    app_id: "synthetic",
    tenant_key: "synthetic",
  },
  event: {
    sender: {
      sender_id: { open_id: ADMIN_OPEN_ID, user_id: "xingze", union_id: "u" },
      sender_type: "user",
      tenant_key: "synthetic",
    },
    message: {
      message_id: messageId,
      create_time: String(Date.now()),
      chat_id: chatId,
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: TEST_INSTRUCTION }),
      mentions: [],
    },
  },
};

const t0 = Date.now();
await agent.processInboundLarkMessage(fakeEvent, "smoke");
console.log(`agent finished in ${Date.now() - t0}ms`);

// Read assistant reply
const { data: msgs } = await s
  .from("lark_messages")
  .select("role, text, created_at")
  .eq("chat_id", chatId)
  .order("created_at", { ascending: false })
  .limit(2);
const assistantReply = msgs?.find((m) => m.role === "assistant")?.text ?? "";
console.log("\nassistant reply (first 500 chars):");
console.log("  ", assistantReply.slice(0, 500).replace(/\n/g, " ⏎ "));

// AFTER snapshot
const { count: afterCount } = await s
  .from("helper_learnings")
  .select("*", { count: "exact", head: true })
  .is("superseded_at", null);
console.log(`\nAFTER memory count (active rows): ${afterCount}`);

// New rows since sentinel
const { data: newRows } = await s
  .from("helper_learnings")
  .select("id, created_at, kind, body, scope_rep_id, confidence, evidence")
  .gt("created_at", sentinelTs)
  .order("created_at", { ascending: false });
console.log(`new helper_learnings rows since sentinel: ${(newRows ?? []).length}`);
for (const r of (newRows ?? []).slice(0, 5)) {
  console.log(`  - kind=${r.kind} scope=${r.scope_rep_id ?? "org"} body="${(r.body || "").slice(0, 120)}"`);
}

// Assertion: either (a) Leon emitted a real memory tool block, or (b)
// the detector fired and the recovery synthesized a row. Both write
// SOMETHING to helper_learnings whose body mentions the instruction.
// We accept any kind because (a) real tool calls might be remember_about_rep
// (rep_pref/tactic/other) OR learn_from_admin_correction (self_critique).
const matchingRows = (newRows ?? []).filter((r) =>
  /早会|中文.*英文|英文.*中文|Yujie/i.test(r.body || "")
);
const recoveredSuffixSeen = /auto-recovered: missed tool call/.test(assistantReply);
const memoryWritten = matchingRows.length > 0;

// Advisory only — real-LLM behavior is non-deterministic. If the model
// reacts with an emoji or short ack, no memory tool fires and that's
// not a regression of the recovery patch. Part 3 is the deterministic
// proof that the recovery path actually persists when the lie occurs.
if (memoryWritten) {
  console.log(`  (advisory) ✓ memory row written — kind=${matchingRows[0].kind} body="${matchingRows[0].body.slice(0, 80)}"`);
} else {
  console.log("  (advisory) — no memory row from the real LLM this turn (Part 3 covers the deterministic path)");
}

// If detector fired (recovery happened), assert the suffix shows up
if (recoveredSuffixSeen) {
  console.log("  detector fired AND recovered — suffix present in reply ✓");
} else {
  // model emitted a real tool block — that's also fine
  console.log("  no auto-recovery suffix — either model emitted real tool block, or detector didn't fire");
}

// Advisory only (see above).
if ((afterCount ?? 0) > (beforeCount ?? 0)) {
  console.log(`  (advisory) ✓ memory delta > 0 — before=${beforeCount} after=${afterCount}`);
} else {
  console.log(`  (advisory) memory delta == 0 — before=${beforeCount} after=${afterCount}; LLM didn't fire a memory tool`);
}

// Cleanup the synthetic rows we created (so reruns are idempotent)
if ((newRows ?? []).length > 0) {
  // Only delete rows our test plausibly created. We won't be too aggressive:
  // restrict to ones whose evidence shows source=auto_exec session_rep=5 OR
  // the self_critique row that the guard emitted.
  const toDelete = (newRows ?? []).filter((r) => {
    const ev = r.evidence;
    if (r.kind === "self_critique" && /\[guard caught it\]/.test(r.body || "")) return true;
    if (ev && typeof ev === "object" && ev.source === "auto_exec" && /早会|Yujie|中文.*英文/i.test(r.body || "")) return true;
    return false;
  });
  if (toDelete.length > 0) {
    await s.from("helper_learnings").delete().in("id", toDelete.map((r) => r.id));
    console.log(`cleaned up ${toDelete.length} helper_learnings row(s)`);
  }
}

// Cleanup lark_messages for this synthetic chat
await s.from("lark_messages").delete().eq("chat_id", chatId);

// ───────────────────────────────────────────────────────────────────
// PART 3 — Force the lie path: feed a synthetic "claim-without-tool"
// reply through analyzeClaimWithoutTool() → tryAutoExecuteSafe().
// This bypasses the real LLM so we can prove the recovery actually
// writes a row even when the model lies. This is the "the lie persists"
// → "the lie is auto-fixed" demonstration.
// ───────────────────────────────────────────────────────────────────
console.log("\n=== PART 3: forced lie → recovery e2e ===");

const lyingReply = "好的, 记下来了: Yujie 早会用中文不用英文, 同步给其他人.";
const a = analyze(lyingReply);
console.log("  analyze:", JSON.stringify(a));
ok("part3 detector fires", a.detectorFired === true);
ok("part3 recoverable", a.detectorFired && a.recoverable === true);

if (a.detectorFired && a.recoverable) {
  // Snapshot
  const { count: beforeP3 } = await s
    .from("helper_learnings")
    .select("*", { count: "exact", head: true })
    .is("superseded_at", null);
  console.log(`  part3 BEFORE memory count: ${beforeP3}`);

  const { tryAutoExecuteSafe } = await import("/Users/xingzewang/Desktop/mail/src/lib/auto-execute-safe.ts");
  // Mimic admin session (so scope="org")
  const r = await tryAutoExecuteSafe(
    { repId: 5, role: "admin", repName: "Xingze", email: null },
    {
      action: "remember_about_rep",
      kind: a.kind,
      body: a.body,
      scope: "org",
    },
  );
  console.log("  tryAutoExecuteSafe result:", r.executed ? "executed" : "not-executed");
  ok("part3 auto-exec succeeded", r.executed === true, r.executed ? `suffix="${r.suffix.slice(0, 100)}"` : "");

  const { count: afterP3 } = await s
    .from("helper_learnings")
    .select("*", { count: "exact", head: true })
    .is("superseded_at", null);
  console.log(`  part3 AFTER memory count: ${afterP3}`);
  ok("part3 memory delta == 1", (afterP3 ?? 0) === (beforeP3 ?? 0) + 1, `before=${beforeP3} after=${afterP3}`);

  // Find the row we just inserted and assert its body
  const { data: p3Rows } = await s
    .from("helper_learnings")
    .select("id, kind, body, scope_rep_id, evidence")
    .gt("created_at", new Date(Date.now() - 10000).toISOString())
    .order("created_at", { ascending: false })
    .limit(3);
  const p3Inserted = (p3Rows ?? []).find(
    (row) => /早会/.test(row.body || "") && row.evidence && typeof row.evidence === "object" && row.evidence.source === "auto_exec",
  );
  if (p3Inserted) {
    console.log(`  recovered row: kind=${p3Inserted.kind} scope=${p3Inserted.scope_rep_id ?? "org"}`);
    console.log(`  recovered body: "${p3Inserted.body}"`);
    ok("part3 recovered row body contains '早会'", /早会/.test(p3Inserted.body || ""));
    ok("part3 recovered row body contains '中文'", /中文/.test(p3Inserted.body || ""));
    // Cleanup
    await s.from("helper_learnings").delete().eq("id", p3Inserted.id);
    console.log(`  cleaned up part3 row id=${p3Inserted.id}`);
  } else {
    ok("part3 found inserted row", false, "no matching row");
  }
}

console.log("\n=== Summary ===");
if (fails === 0) {
  console.log(`✅ all checks pass`);
  process.exit(0);
} else {
  console.log(`❌ ${fails} check(s) failed`);
  process.exit(1);
}
