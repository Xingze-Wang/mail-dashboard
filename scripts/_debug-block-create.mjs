// Probe: what payload shape does Lark accept for inserting blocks
// into a brand-new doc? Try the rich shape side-by-side with the plain
// text shape so we can see which one errors and why.
import { readFileSync } from "node:fs";
const envFile = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}

async function getToken() {
  const r = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: process.env.LARK_APP_ID, app_secret: process.env.LARK_APP_SECRET }),
  });
  return (await r.json()).tenant_access_token;
}
const token = await getToken();

// Create a fresh doc for the test
async function createDoc(title) {
  const r = await fetch(`https://open.feishu.cn/open-apis/docx/v1/documents`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ title }),
  });
  const j = await r.json();
  return j.data?.document?.document_id;
}

async function appendChildren(docId, children) {
  const r = await fetch(`https://open.feishu.cn/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ children, index: 0 }),
  });
  return await r.json();
}

// Test 1: plain text block (known to work — createLarkDoc uses this)
const docId1 = await createDoc("PROBE plain text " + Date.now());
console.log("\n=== test 1: plain paragraph ===");
const r1 = await appendChildren(docId1, [{
  block_type: 2,
  text: { elements: [{ text_run: { content: "hello" } }] },
}]);
console.log("plain:", JSON.stringify(r1));

// Test 2: heading (h1, block_type=3)
const docId2 = await createDoc("PROBE heading " + Date.now());
console.log("\n=== test 2: heading payload variant A (heading1 field) ===");
const r2a = await appendChildren(docId2, [{
  block_type: 3,
  heading1: { elements: [{ text_run: { content: "Doc Edit Smoke Test" } }] },
}]);
console.log("heading variant A:", JSON.stringify(r2a));

// Test 3: heading variant B — Lark might want it under `text` even for headings
const docId3 = await createDoc("PROBE heading B " + Date.now());
console.log("\n=== test 3: heading payload variant B (text field) ===");
const r3 = await appendChildren(docId3, [{
  block_type: 3,
  text: { elements: [{ text_run: { content: "Heading via text field" } }] },
}]);
console.log("heading variant B:", JSON.stringify(r3));

// Test 4: mixed list (the failing case)
const docId4 = await createDoc("PROBE mixed " + Date.now());
console.log("\n=== test 4: mixed [h1, paragraph, paragraph] (variant A) ===");
const r4 = await appendChildren(docId4, [
  { block_type: 3, heading1: { elements: [{ text_run: { content: "Doc Edit Smoke Test" } }] } },
  { block_type: 2, text: { elements: [{ text_run: { content: "Original second paragraph." } }] } },
  { block_type: 2, text: { elements: [{ text_run: { content: "Third paragraph." } }] } },
]);
console.log("mixed variant A:", JSON.stringify(r4));
