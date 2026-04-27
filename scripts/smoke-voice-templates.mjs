// UI smoke for /settings/voice-templates.
//
// Mints an admin JWT (uses AUTH_SECRET from .env.local) and walks
// the new endpoints in sequence:
//   1. /api/email-templates                          — list templates
//   2. /api/templates/performance?days=30            — perf chips
//   3. /api/templates/preview/leads                  — preview dropdown
//   4. /api/templates/preview?templateId=&leadId=    — render preview
//   5. /api/email-templates/[id]/versions            — history list
//   6. /api/email-templates/overrides?templateId=    — overrides list
//   7. POST + DELETE /api/email-templates/overrides  — add + remove
//
// Reports per-step OK / FAIL with status + first 200 chars of body.
//
// Run: node scripts/smoke-voice-templates.mjs

import { readFileSync } from "node:fs";
import { SignJWT } from "jose";

const env = readFileSync(".env.local", "utf8").split("\n");
function envVar(name) {
  const line = env.find((l) => l.startsWith(`${name}=`));
  return line?.slice(name.length + 1).replace(/^["']|["']$/g, "").trim();
}
const secret = envVar("AUTH_SECRET");
if (!secret) {
  console.error("AUTH_SECRET not in .env.local");
  process.exit(1);
}

// Mint a session for rep id 5 (Xingze, admin).
const token = await new SignJWT({
  repId: 5,
  repName: "Xingze Wang",
  email: "smoke@local",
  role: "admin",
})
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime("1h")
  .sign(new TextEncoder().encode(secret));

const cookie = `qiji_session=${token}`;
const BASE = "http://localhost:3000";

let pass = 0;
let fail = 0;
const fails = [];

async function step(label, url, init = {}) {
  const r = await fetch(BASE + url, { ...init, headers: { cookie, ...(init.headers ?? {}) } });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  const ok = r.ok;
  if (ok) {
    pass++;
    console.log(`PASS  ${r.status}  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${r.status}  ${label}`);
    console.log(`      body: ${(typeof body === "string" ? body : JSON.stringify(body)).slice(0, 240)}`);
    fails.push({ label, status: r.status, body });
  }
  return { ok, body };
}

console.log("=== Voice Templates UI smoke ===\n");

const list = await step("list templates", "/api/email-templates");
const templates = list.body?.templates ?? [];
if (templates.length === 0) {
  console.log("\nNo templates exist — can't continue. Seed at least one (e.g. global) first.");
  process.exit(1);
}
const tplId = templates[0].id;
console.log(`     using template: ${templates[0].name} (${tplId})\n`);

const perf = await step("perf 30d", "/api/templates/performance?days=30");
const perfRow = perf.body?.templates?.find((t) => t.id === tplId);
if (perfRow) console.log(`     ${tplId} sent=${perfRow.sent} click=${perfRow.clicked} wechat=${perfRow.wechat}`);

const leads = await step("preview leads (5 recent)", "/api/templates/preview/leads");
const leadId = leads.body?.leads?.[0]?.id;
if (!leadId) {
  console.log("\nNo recent leads — preview can't run.");
} else {
  await step(`preview render`, `/api/templates/preview?templateId=${tplId}&leadId=${leadId}`);
}

await step("versions list", `/api/email-templates/${tplId}/versions`);

await step("overrides list", `/api/email-templates/overrides?templateId=${tplId}`);

const created = await step("add override", "/api/email-templates/overrides", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    templateId: tplId,
    slotName: "subject_format",
    when: { geo: "cn" },
    value: "SMOKE_OVERRIDE_VALUE — delete me",
  }),
});
const overrideId = created.body?.override?.id;
if (overrideId) {
  await step("delete override", `/api/email-templates/overrides?id=${overrideId}`, { method: "DELETE" });
} else {
  console.log("     skipping delete — POST didn't return an id");
}

console.log(`\nResult: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
