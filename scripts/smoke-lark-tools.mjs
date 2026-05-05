// Smoke test for the new Lark tools. Run against the LIVE tenant.
//
// Each test does the smallest thing that proves the API path works and
// returns something we can verify (URL, record id, message id). Cleanups
// happen at the end so we don't pollute the workspace.
//
// Run:
//   node scripts/smoke-lark-tools.mjs

import "dotenv/config";
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

const APP_ID = process.env.LARK_APP_ID;
const APP_SECRET = process.env.LARK_APP_SECRET;
const REGION = process.env.LARK_REGION ?? "cn";
const BASE = REGION === "cn" ? "https://open.feishu.cn/open-apis" : "https://open.larksuite.com/open-apis";

if (!APP_ID || !APP_SECRET) {
  console.error("✗ LARK_APP_ID + LARK_APP_SECRET required");
  process.exit(1);
}

async function getToken() {
  const r = await fetch(`${BASE}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const j = await r.json();
  if (!j.tenant_access_token) throw new Error("token failed: " + JSON.stringify(j));
  return j.tenant_access_token;
}

async function api(token, method, path, { body, query } = {}) {
  const qs = query ? "?" + new URLSearchParams(query).toString() : "";
  const init = {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  };
  if (body) init.body = JSON.stringify(body);
  const r = await fetch(`${BASE}${path}${qs}`, init);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.code !== 0) throw new Error(`${method} ${path} → code=${j.code} msg="${j.msg}"`);
  return j.data;
}

const token = await getToken();
console.log("✓ tenant token");

const cleanup = []; // { fn, label }
let passed = 0, failed = 0;
const fail = (label, e) => { failed++; console.error(`✗ ${label}: ${e?.message ?? e}`); };
const pass = (label, info) => { passed++; console.log(`✓ ${label}${info ? "  " + info : ""}`); };

// ─── Test 1: dm_user (send a text DM to Xingze) ──────────────────────────
const XINGZE_OPEN_ID = "ou_395f934f5add3c398bed6be8f258246b";
try {
  const sent = await api(token, "POST", "/im/v1/messages", {
    body: {
      receive_id: XINGZE_OPEN_ID,
      msg_type: "text",
      content: JSON.stringify({ text: "🤖 [smoke test] dm_user — " + new Date().toISOString() }),
    },
    query: { receive_id_type: "open_id" },
  });
  pass("dm_user", "→ message_id=" + sent.message_id);
} catch (e) { fail("dm_user", e); }

// ─── Test 2: createLarkDoc ───────────────────────────────────────────────
let testDocId = null;
try {
  const created = await api(token, "POST", "/docx/v1/documents", {
    body: { title: "🤖 Smoke test " + new Date().toISOString().slice(0, 19) },
  });
  testDocId = created.document.document_id;
  cleanup.push({
    fn: () => api(token, "DELETE", `/drive/v1/files/${testDocId}`, { query: { type: "docx" } }),
    label: "delete test doc",
  });
  // Append one paragraph block
  await api(token, "POST", `/docx/v1/documents/${testDocId}/blocks/${testDocId}/children`, {
    body: {
      children: [{
        block_type: 2,
        text: { elements: [{ text_run: { content: "Hello from the smoke test." } }] },
      }],
      index: 0,
    },
  });
  // Re-read the raw_content to confirm body landed
  const raw = await api(token, "GET", `/docx/v1/documents/${testDocId}/raw_content`, { query: { lang: 0 } });
  if (!raw.content || !raw.content.includes("Hello from the smoke test")) {
    throw new Error("body didn't land in doc — raw=" + JSON.stringify(raw).slice(0, 200));
  }
  pass("create_lark_doc + append + read", `→ doc_id=${testDocId}`);
} catch (e) { fail("create_lark_doc", e); }

// ─── Test 3: listLarkBases ───────────────────────────────────────────────
try {
  const list = await api(token, "GET", "/drive/v1/files", {
    query: { page_size: "20", order_by: "EditedTime", direction: "DESC" },
  });
  const bases = (list.files ?? []).filter((f) => f.type === "bitable");
  pass("list_lark_bases", `→ ${bases.length} bases visible (out of ${(list.files ?? []).length} total files)`);
} catch (e) { fail("list_lark_bases", e); }

// ─── Test 4: createLarkBase + addToLarkBase ─────────────────────────────
let testAppToken = null;
let testTableId = null;
try {
  // Create a temporary base
  const base = await api(token, "POST", "/bitable/v1/apps", {
    body: { name: "🤖 Smoke base " + Date.now(), folder_token: "" },
  });
  testAppToken = base.app.app_token;
  cleanup.push({
    fn: () => api(token, "DELETE", `/drive/v1/files/${testAppToken}`, { query: { type: "bitable" } }),
    label: "delete test base",
  });
  // List its default table
  const tables = await api(token, "GET", `/bitable/v1/apps/${testAppToken}/tables`);
  testTableId = tables.items?.[0]?.table_id;
  if (!testTableId) throw new Error("no default table found in new base");

  // Discover the field name for the primary text column
  const fields = await api(token, "GET", `/bitable/v1/apps/${testAppToken}/tables/${testTableId}/fields`);
  const primaryName = fields.items?.[0]?.field_name;
  if (!primaryName) throw new Error("no primary field in default table");

  // Insert a record
  const rec = await api(token, "POST", `/bitable/v1/apps/${testAppToken}/tables/${testTableId}/records`, {
    body: { fields: { [primaryName]: "smoke row " + new Date().toISOString().slice(0, 19) } },
  });
  pass("add_to_lark_base", `→ record_id=${rec.record.record_id} on table ${testTableId}`);
} catch (e) { fail("add_to_lark_base", e); }

// ─── Test 5: findLarkUserByEmail ─────────────────────────────────────────
try {
  // Use Xingze's email if set in env; fall back to inviting a known one
  const email = process.env.SMOKE_TEST_EMAIL ?? "xw2893@columbia.edu";
  const r = await api(token, "POST", "/contact/v3/users/batch_get_id", {
    body: { emails: [email] },
    query: { user_id_type: "open_id" },
  });
  const first = r.user_list?.[0];
  if (!first?.user_id) {
    pass("find_lark_user_by_email", `→ email "${email}" not in tenant (expected for non-employees)`);
  } else {
    pass("find_lark_user_by_email", `→ open_id=${first.user_id}`);
  }
} catch (e) { fail("find_lark_user_by_email", e); }

// ─── Cleanup ────────────────────────────────────────────────────────────
console.log("\n--- cleanup ---");
for (const { fn, label } of cleanup) {
  try { await fn(); console.log(`✓ ${label}`); }
  catch (e) { console.log(`✗ ${label}: ${e?.message ?? e}`); }
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
