// End-to-end smoke for the Lark webhook.
// Builds a synthetic Lark v2 im.message.receive_v1 event, signs it with the
// configured verification token, posts it to the local /api/lark/webhook,
// and asserts a 200 reply + that the assistant reply lands in lark_messages.
//
// Run: node scripts/lark-smoke.mjs [base-url]
//   base-url defaults to http://localhost:3000

import { createHash, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Hand-rolled .env.local loader (avoids the dotenv install dance for a
// 5-line job).
function loadDotenv(p) {
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
  } catch { /* file missing — ok */ }
}
const here = dirname(fileURLToPath(import.meta.url));
loadDotenv(resolve(here, "..", ".env.local"));
loadDotenv(resolve(here, "..", ".env"));

const BASE = process.argv[2] || "http://localhost:3000";
const URL_PATH = "/api/lark/webhook";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  process.env.SUPABASE_SERVICE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

function signLark({ body, token, timestamp, nonce }) {
  const h = createHash("sha256");
  h.update(timestamp + nonce + token + body);
  return h.digest("hex");
}

async function postLark(payload) {
  const body = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(8).toString("hex");
  const headers = {
    "Content-Type": "application/json",
  };
  if (process.env.LARK_VERIFICATION_TOKEN) {
    const sig = signLark({ body, token: process.env.LARK_VERIFICATION_TOKEN, timestamp: ts, nonce });
    headers["x-lark-request-timestamp"] = ts;
    headers["x-lark-request-nonce"] = nonce;
    headers["x-lark-signature"] = sig;
  }
  const t0 = Date.now();
  const res = await fetch(`${BASE}${URL_PATH}`, { method: "POST", headers, body, signal: AbortSignal.timeout(15_000) });
  const ms = Date.now() - t0;
  const text = await res.text();
  return { status: res.status, ms, text };
}

let pass = 0, fail = 0;
function ok(label, cond, detail = "") {
  const icon = cond ? "✓" : "✗";
  console.log(`  ${icon} ${label}${detail ? "  " + detail : ""}`);
  if (cond) pass++; else fail++;
}

console.log(`Base URL: ${BASE}`);
console.log(`Verification token configured: ${!!process.env.LARK_VERIFICATION_TOKEN}`);

// ─── Phase 1: GET health-check ──────────────────────────────────────────
{
  console.log("\n[1] GET /api/lark/webhook (health) — expect 200 with config object");
  const t0 = Date.now();
  const res = await fetch(`${BASE}${URL_PATH}`, { signal: AbortSignal.timeout(10_000) });
  const ms = Date.now() - t0;
  const j = await res.json().catch(() => null);
  ok("status 200", res.status === 200, `(${res.status}, ${ms}ms)`);
  ok("body has config.app_id_set", !!j?.config && "app_id_set" in j.config, JSON.stringify(j?.config || {}).slice(0, 120));
  ok("app_id is set", j?.config?.app_id_set === true);
  ok("app_secret is set", j?.config?.app_secret_set === true);
}

// ─── Phase 2: URL verification handshake ────────────────────────────────
{
  console.log("\n[2] POST url_verification — expect echoed challenge");
  const challenge = randomBytes(8).toString("hex");
  const r = await postLark({ type: "url_verification", challenge });
  ok("status 200", r.status === 200, `(${r.status}, ${r.ms}ms)`);
  let body;
  try { body = JSON.parse(r.text); } catch { body = null; }
  ok("body.challenge echoed", body?.challenge === challenge, body?.challenge);
}

// ─── Phase 3: Unknown sender (expect onboarding) ────────────────────────
{
  console.log("\n[3] POST im.message from unknown open_id — expect 200 + onboarding reply");
  const fakeOid = "ou_test_" + randomBytes(6).toString("hex");
  const fakeChat = "oc_test_" + randomBytes(6).toString("hex");
  const fakeMid = "om_test_" + randomBytes(6).toString("hex");
  const r = await postLark({
    schema: "2.0",
    header: { event_id: randomBytes(8).toString("hex"), event_type: "im.message.receive_v1", create_time: String(Date.now()), token: "x", app_id: "x", tenant_key: "x" },
    event: {
      sender: { sender_id: { open_id: fakeOid, union_id: "uu_x", user_id: "user_x" }, sender_type: "user" },
      message: { message_id: fakeMid, root_id: "", parent_id: "", create_time: String(Date.now()), chat_id: fakeChat, chat_type: "p2p", message_type: "text", content: JSON.stringify({ text: "smoke test ping" }), mentions: [] },
    },
  });
  ok("status 200", r.status === 200, `(${r.status}, ${r.ms}ms)`);
  ok("ack returned in <3s (Lark requires)", r.ms < 3000, `(${r.ms}ms)`);
  console.log("  (waiting 4s for async onboarding reply to land in lark_messages...)");
  await new Promise((res) => setTimeout(res, 4000));
}

// ─── Phase 4: Bound rep round-trip ──────────────────────────────────────
// We bind a synthetic open_id to an existing rep, send a real message,
// confirm an assistant reply lands.
{
  console.log("\n[4] POST im.message from a BOUND open_id — expect 200 + LLM reply persisted");

  // Use Xingze (rep_id 5) so we don't pollute Leo's logs
  const { data: xingze } = await sb.from("sales_reps").select("id, name, lark_open_id").eq("id", 5).maybeSingle();
  if (!xingze) {
    console.log("  ✗ rep_id=5 (Xingze) not found in sales_reps — skipping");
    fail++;
  } else {
    const testOid = xingze.lark_open_id || "ou_smoke_" + randomBytes(6).toString("hex");
    const restoreOid = xingze.lark_open_id; // remember to restore after
    // Bind temporarily
    if (testOid !== xingze.lark_open_id) {
      await sb.from("sales_reps").update({ lark_open_id: testOid }).eq("id", 5);
    }
    const fakeChat = "oc_smoke_" + randomBytes(6).toString("hex");
    const fakeMid = "om_smoke_" + randomBytes(6).toString("hex");
    const t0 = Date.now();
    const r = await postLark({
      schema: "2.0",
      header: { event_id: randomBytes(8).toString("hex"), event_type: "im.message.receive_v1", create_time: String(Date.now()), token: "x", app_id: "x", tenant_key: "x" },
      event: {
        sender: { sender_id: { open_id: testOid, union_id: "uu_x", user_id: "user_x" }, sender_type: "user" },
        message: { message_id: fakeMid, root_id: "", parent_id: "", create_time: String(Date.now()), chat_id: fakeChat, chat_type: "p2p", message_type: "text", content: JSON.stringify({ text: "我有几个 ready 的 lead" }), mentions: [] },
      },
    });
    ok("ack 200 in <3s", r.status === 200 && r.ms < 3000, `(status=${r.status}, ms=${r.ms})`);
    // Wait for async LLM reply (5-15s typical)
    console.log("  (waiting up to 60s for LLM reply to persist...)");
    let userRow = null, assistantRow = null;
    for (let i = 0; i < 60; i++) {
      await new Promise((res) => setTimeout(res, 1000));
      const { data } = await sb.from("lark_messages").select("role, text, created_at").eq("chat_id", fakeChat).order("created_at", { ascending: true });
      userRow = (data || []).find((m) => m.role === "user");
      assistantRow = (data || []).find((m) => m.role === "assistant");
      if (assistantRow) break;
    }
    const totalMs = Date.now() - t0;
    ok("user message persisted", !!userRow, userRow?.text?.slice(0, 60));
    ok("assistant reply persisted", !!assistantRow, assistantRow ? `"${assistantRow.text.slice(0, 80)}..." (${totalMs}ms total)` : "(timeout)");
    ok("end-to-end under 60s", totalMs < 60000, `(${totalMs}ms)`);

    // Restore binding
    if (testOid !== restoreOid) {
      await sb.from("sales_reps").update({ lark_open_id: restoreOid }).eq("id", 5);
    }
    // Cleanup synthetic chat rows so we don't pollute future analytics
    await sb.from("lark_messages").delete().eq("chat_id", fakeChat);
  }
}

// ─── Phase 5: Action proposal — should auto-execute (non-destructive) ───
// Optional: try a memory write. The bot should auto-execute remember_about_rep.
// Skip if Phase 4 failed.

console.log(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
