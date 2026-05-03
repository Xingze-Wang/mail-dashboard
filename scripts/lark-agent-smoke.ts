// Smoke test for src/lib/lark-agent.ts — the shared inbound processor.
// Confirms both transports (webhook + ws worker) get the same behavior
// since they both call this function.
//
// Builds a synthetic Lark v2 im.message.receive_v1 event payload and
// passes it directly to processInboundLarkMessage, then asserts:
//   - assistant reply landed in lark_messages
//   - reply contains real LLM-generated text
//   - duplicate event_id is deduped
//
// Run: npx tsx scripts/lark-agent-smoke.ts

// Load env BEFORE any other imports so src/lib/db.ts (transitive via
// lark-agent) sees SUPABASE_SERVICE_KEY at module-load time.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
function loadDotenv(p: string) {
  try {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!process.env[m[1]]) process.env[m[1]] = v;
    }
  } catch {}
}
const here = dirname(fileURLToPath(import.meta.url));
loadDotenv(resolve(here, "..", ".env.local"));
loadDotenv(resolve(here, "..", ".env"));


let pass = 0, fail = 0;
function ok(label: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? "  " + detail : ""}`);
  cond ? pass++ : fail++;
}

async function main() {
const { createClient } = await import("@supabase/supabase-js");
const { randomBytes } = await import("node:crypto");
const { processInboundLarkMessage } = await import("../src/lib/lark-agent.ts");
const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://erguqrisqtugfysofwdd.supabase.co",
  process.env.SUPABASE_SERVICE_KEY ?? "",
  { auth: { persistSession: false } },
);
function makeEvent(text: string, openId: string, chatId?: string, messageId?: string) {
  return {
    schema: "2.0",
    header: { event_id: "evt_" + randomBytes(8).toString("hex"), event_type: "im.message.receive_v1" },
    event: {
      sender: { sender_id: { open_id: openId, union_id: "uu_x", user_id: "user_x" }, sender_type: "user" },
      message: {
        message_id: messageId ?? "om_" + randomBytes(8).toString("hex"),
        chat_id: chatId ?? "oc_" + randomBytes(8).toString("hex"),
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text }),
        mentions: [],
      },
    },
  };
}

console.log("\n[1] processInboundLarkMessage with bound rep — expect assistant reply persisted");
{
  const { data: xingze } = await sb.from("sales_reps").select("id, lark_open_id").eq("id", 5).maybeSingle();
  if (!xingze) { console.error("rep_id=5 not found"); process.exit(1); }
  const testOid = xingze.lark_open_id || "ou_smoke_" + randomBytes(6).toString("hex");
  const restoreOid = xingze.lark_open_id;
  if (testOid !== xingze.lark_open_id) {
    await sb.from("sales_reps").update({ lark_open_id: testOid }).eq("id", 5);
  }

  const chatId = "oc_smoke_" + randomBytes(6).toString("hex");
  const event = makeEvent("我有几个 ready 的 lead", testOid, chatId);
  const t0 = Date.now();
  const result = await processInboundLarkMessage(event, "ws");
  const elapsed = Date.now() - t0;
  ok("returns ok=true", result.ok, `(${elapsed}ms)`);

  const { data: rows } = await sb.from("lark_messages").select("role, text").eq("chat_id", chatId).order("created_at", { ascending: true });
  const userRow = (rows || []).find((r) => r.role === "user");
  const asstRow = (rows || []).find((r) => r.role === "assistant");
  ok("user message persisted", !!userRow, userRow?.text?.slice(0, 60));
  ok("assistant reply persisted", !!asstRow, asstRow ? `"${asstRow.text.slice(0, 80)}..."` : "(missing)");
  ok("assistant reply non-trivial (>20 chars)", (asstRow?.text?.length ?? 0) > 20);

  // Dedup: re-fire same event_id
  const r2 = await processInboundLarkMessage(event, "ws");
  // (Note: the in-memory dedup is in the worker, not the lib; lib uses
  // message_id pre-check. We re-send the same envelope — the lib should
  // see the message_id row exists and skip.)
  ok("re-fire returns ok with dedup reason", r2.ok && /duplicate/.test(r2.reason ?? ""), `reason="${r2.reason}"`);

  // Cleanup
  if (testOid !== restoreOid) {
    await sb.from("sales_reps").update({ lark_open_id: restoreOid }).eq("id", 5);
  }
  await sb.from("lark_messages").delete().eq("chat_id", chatId);
}

console.log("\n[2] unknown sender — expect onboarding reply, no LLM call");
{
  const orphanOid = "ou_orphan_" + randomBytes(6).toString("hex");
  const chatId = "oc_orphan_" + randomBytes(6).toString("hex");
  const event = makeEvent("test from orphan", orphanOid, chatId);
  const t0 = Date.now();
  const result = await processInboundLarkMessage(event, "ws");
  const elapsed = Date.now() - t0;
  ok("returns ok with onboarding reason", result.ok && result.reason === "onboarding-reply", `(${elapsed}ms, reason="${result.reason}")`);
  ok("orphan completes quickly (<2s — no LLM)", elapsed < 2000, `(${elapsed}ms)`);

  const { data: rows } = await sb.from("lark_messages").select("role, rep_id").eq("chat_id", chatId);
  const orphanRow = (rows || []).find((r) => r.role === "user" && r.rep_id === null);
  ok("orphan user message persisted with rep_id=null", !!orphanRow);

  await sb.from("lark_messages").delete().eq("chat_id", chatId);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
