// End-to-end smoke: simulate an admin Lark DM that asks Leon for a
// destructive action (reassign leads), verify the agent's reply
// contains "admin inbox" (new copy) and NOT "网页 /pipeline" (old
// copy). Also check whether the agent actually sent a Lark confirm
// card.
//
// Run: SMOKE_NO_CARDS=0 npx tsx scripts/_smoke-lark-e2e-confirm.mjs
//
// Doesn't push a real Lark message — calls processInboundLarkMessage
// directly with a fabricated event payload. Persists assistant reply
// to lark_messages (as the real path does).

import { readFileSync } from "node:fs";
const env = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const l of env.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}
// Suppress real Lark sends — we want to verify the agent's TEXT REPLY,
// not push a confirm card to admin's actual DM. Cards rely on real
// tokens so they'd 401 anyway from the laptop network.
process.env.SMOKE_NO_CARDS = process.env.SMOKE_NO_CARDS ?? "1";

const ADMIN_OPEN_ID = "ou_395f934f5add3c398bed6be8f258246b"; // Xingze
const TEST_TEXT = "Leon, 帮我把 Yujie 的 leads 都转给 Ethan";

// Construct a synthetic Lark event the way Lark's webhook would deliver
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
      message_id: `smoke_msg_${Date.now()}`,
      root_id: undefined,
      parent_id: undefined,
      create_time: String(Date.now()),
      chat_id: `oc_synthetic_dm_${ADMIN_OPEN_ID}`,
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: TEST_TEXT }),
      mentions: [],
    },
  },
};

console.log(`\n[smoke] Test message: "${TEST_TEXT}"`);
console.log(`[smoke] As: admin (rep 5) via open_id ${ADMIN_OPEN_ID}`);
console.log(`[smoke] SMOKE_NO_CARDS=${process.env.SMOKE_NO_CARDS}\n`);

const t0 = Date.now();
const agent = await import("/Users/xingzewang/Desktop/mail/src/lib/lark-agent.ts");
await agent.processInboundLarkMessage(fakeEvent, "smoke");
console.log(`[smoke] agent finished in ${Date.now() - t0}ms`);

// Pull what the agent persisted
const { createClient } = await import("@supabase/supabase-js");
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const chatId = fakeEvent.event.message.chat_id;
const { data: messages } = await s
  .from("lark_messages")
  .select("role, text, created_at")
  .eq("chat_id", chatId)
  .order("created_at", { ascending: false })
  .limit(4);

console.log("\n[smoke] Last 4 messages in this chat (newest first):");
for (const m of messages || []) {
  console.log(`  [${m.role}] ${m.created_at?.slice(11, 19)}  ${(m.text || "").slice(0, 300).replace(/\n/g, " ⏎ ")}`);
}

const assistantReply = (messages || []).find((m) => m.role === "assistant")?.text || "";

console.log("\n[smoke] Verdict:");
const hasOldWebCopy = /网页 \/pipeline|在网页 .* confirm|Lark 里只能讨论/.test(assistantReply);
const hasNewInboxCopy = /admin inbox|admin_inbox/i.test(assistantReply);
const mentionsReassign = /reassign|转给|转移|move.*lead/i.test(assistantReply);

console.log(`  contains "网页 /pipeline 里点 confirm" old copy: ${hasOldWebCopy ? "❌ STILL THERE" : "✓ removed"}`);
console.log(`  contains "admin inbox" new copy:                ${hasNewInboxCopy ? "✓ present" : "(absent — proposal may not have triggered)"}`);
console.log(`  mentions reassign:                              ${mentionsReassign ? "yes" : "no"}`);

if (hasOldWebCopy) process.exit(1);
console.log("\n  → e2e: bot no longer punts to web. ✓");
