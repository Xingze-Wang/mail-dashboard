// Probe: what does Lark actually return for /docx/v1/documents/<id>/blocks
// with various queries? Need this to fix listLarkDocBlocks.
import { readFileSync } from "node:fs";
const envFile = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}
const docId = "WOwVdKt1ro7TbLxZRZWcToganMd";

// Use the same callLarkApi indirectly via getLarkDoc, then a raw fetch
async function getToken() {
  const r = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: process.env.LARK_APP_ID, app_secret: process.env.LARK_APP_SECRET }),
  });
  const j = await r.json();
  return j.tenant_access_token;
}

const token = await getToken();
console.log("Token:", token?.slice(0, 16) + "...");

// Try multiple query forms
for (const query of ["", "?page_size=500", "?page_size=500&document_revision_id=-1"]) {
  console.log(`\n--- GET /docx/v1/documents/${docId}/blocks${query} ---`);
  const r = await fetch(`https://open.feishu.cn/open-apis/docx/v1/documents/${docId}/blocks${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = await r.json();
  console.log("code:", j.code, "msg:", j.msg);
  console.log("items count:", j.data?.items?.length);
  if (j.data?.items) {
    for (const b of j.data.items) {
      const text = ["text", "heading1", "heading2", "callout", "bullet"].map((k) => {
        const v = b[k]?.elements?.map((e) => e.text_run?.content).join("");
        return v ? `${k}:"${v.slice(0, 50)}"` : null;
      }).filter(Boolean).join(" ");
      console.log("  block_id:", b.block_id, "type:", b.block_type, "parent:", b.parent_id, text);
    }
  }
}
