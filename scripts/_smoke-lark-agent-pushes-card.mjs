// END-TO-END agent smoke. This is the test the previous smokes didn't do.
//
// Previous smokes proved that functions work in isolation
// (sendAdminInboxCard pushes, processAdminInboxCardAction handles,
// processRepTemplateCardAction flips rep_approved_at). That's NOT what
// matters. What matters: does the AGENT — when an admin sends a
// natural-language Lark message — actually emit a tool block that
// fires the card?
//
// The user's framing: "you smoke tested by probing the functions but
// you never smoke tested if the agent knows or will use the function."
// Right.
//
// This smoke:
//   1. Synthesizes a Lark `im.message.receive_v1` event from admin
//      with NATURAL language: "把 Yujie 的 lead 都转给 Ethan"
//   2. Calls processInboundLarkMessage (the real entry point — same
//      function the production webhook calls)
//   3. Reads back what got persisted to admin_inbox + the assistant
//      reply text
//   4. Asserts:
//      - admin_inbox row exists with kind='request' and headline
//        mentioning the proposal action
//      - assistant reply does NOT contain "网页 /pipeline"
//      - admin_inbox row's evidence contains the original proposal
//   5. Cleans up: deletes the synthetic admin_inbox row.
//
// Run: SMOKE_NO_CARDS=1 npx tsx scripts/_smoke-lark-agent-pushes-card.mjs
//
// SMOKE_NO_CARDS=1 means the Lark push is skipped (avoid spam per
// feedback_no_smoke_to_prod_lark) but admin_inbox row IS still written
// — so we can verify the agent DECIDED to record it, even if the actual
// Lark API call is suppressed in test.

import { readFileSync } from "node:fs";
const env = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const l of env.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}
process.env.SMOKE_NO_CARDS = process.env.SMOKE_NO_CARDS ?? "1";

const ADMIN_OPEN_ID = "ou_395f934f5add3c398bed6be8f258246b"; // Xingze (admin, rep_id=5)

// ── Natural-language test cases ───────────────────────────────────────
// These are messages an admin might naturally send to Leon. None of
// them explicitly say "record this to admin_inbox" or "push a card" —
// the agent has to figure out the right tool itself.
const CASES = [
  {
    name: "natural reassign request",
    text: "把 Yujie 的所有 lead 都转给 Ethan",
    expects_admin_inbox: true,
    expected_action_substring: /reassign/i,
  },
];

const { createClient } = await import("@supabase/supabase-js");
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

let totalFails = 0;

for (const c of CASES) {
  console.log(`\n=== Case: ${c.name} ===`);
  console.log(`Admin says: "${c.text}"`);

  const chatId = `oc_synthetic_${ADMIN_OPEN_ID}_${Date.now()}`;
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
        content: JSON.stringify({ text: c.text }),
        mentions: [],
      },
    },
  };

  // Snapshot admin_inbox before
  const { data: beforeInbox } = await s
    .from("admin_inbox")
    .select("id")
    .gte("created_at", new Date(Date.now() - 5000).toISOString());
  const beforeCount = beforeInbox?.length ?? 0;

  const t0 = Date.now();
  const agent = await import("/Users/xingzewang/Desktop/mail/src/lib/lark-agent.ts");
  await agent.processInboundLarkMessage(fakeEvent, "smoke");
  const elapsed = Date.now() - t0;
  console.log(`  agent finished in ${elapsed}ms`);

  // Read assistant reply
  const { data: msgs } = await s
    .from("lark_messages")
    .select("role, text, created_at")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(2);
  const assistantReply = msgs?.find((m) => m.role === "assistant")?.text ?? "";
  console.log("  assistant reply (first 300 chars):", assistantReply.slice(0, 300).replace(/\n/g, " ⏎ "));

  // Read what was inserted into admin_inbox in the same window
  const { data: afterInbox } = await s
    .from("admin_inbox")
    .select("id, kind, headline, body, evidence, created_at")
    .gte("created_at", new Date(t0 - 1000).toISOString())
    .order("created_at", { ascending: false })
    .limit(5);
  const newRows = (afterInbox ?? []).filter(
    (r) => !(beforeInbox ?? []).some((b) => b.id === r.id),
  );
  console.log(`  admin_inbox rows added during this turn: ${newRows.length}`);

  // ── Assertions ──
  const checks = [];
  // (1) old "网页 /pipeline" copy is gone
  const hasOldWebCopy = /网页 \/pipeline|Lark 里只能讨论/.test(assistantReply);
  checks.push({ name: "no '网页 confirm' copy in reply", ok: !hasOldWebCopy });

  // (2) admin_inbox row pushed
  if (c.expects_admin_inbox) {
    checks.push({
      name: "admin_inbox row was inserted",
      ok: newRows.length > 0,
      detail: newRows.length > 0 ? `headline="${newRows[0].headline}"` : "no rows inserted",
    });

    // (3) headline mentions the action
    if (newRows.length > 0) {
      const row = newRows[0];
      const headlineMatches = c.expected_action_substring.test(row.headline ?? "");
      checks.push({
        name: `headline contains ${c.expected_action_substring}`,
        ok: headlineMatches,
        detail: `actual: "${row.headline}"`,
      });
      const evMatches = c.expected_action_substring.test(JSON.stringify(row.evidence ?? {}));
      checks.push({
        name: `evidence contains ${c.expected_action_substring}`,
        ok: evMatches,
      });
    }
  }

  let caseFails = 0;
  for (const ch of checks) {
    console.log(`  ${ch.ok ? "✓" : "✗"} ${ch.name}${ch.detail ? " — " + ch.detail : ""}`);
    if (!ch.ok) caseFails++;
  }
  if (caseFails > 0) {
    totalFails++;
    console.log(`  ❌ ${caseFails} check(s) failed`);
  } else {
    console.log(`  ✅ all ${checks.length} checks pass`);
  }

  // Cleanup: delete the rows we just created so reruns are idempotent
  if (newRows.length > 0) {
    await s.from("admin_inbox").delete().in("id", newRows.map((r) => r.id));
    console.log(`  cleaned up ${newRows.length} admin_inbox row(s)`);
  }
}

console.log(`\n=== Summary ===`);
if (totalFails === 0) {
  console.log(`✅ all ${CASES.length} case(s) pass — the agent uses the right tool when an admin asks naturally`);
  process.exit(0);
} else {
  console.log(`❌ ${totalFails} case(s) had failures — the agent is not actually pushing cards`);
  process.exit(1);
}
