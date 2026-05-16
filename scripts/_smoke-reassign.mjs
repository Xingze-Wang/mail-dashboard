// End-to-end smoke for the /pipeline "Re-assign…" admin tool.
//
// User reported "clicking the Re-assign button does nothing". This
// smoke proves the POST endpoint is alive and answers correctly with
// a real admin JWT. The UI fix (if any) lands in page.tsx /
// ReassignModal.tsx; this script is the API half.
//
// Strategy:
//   1. Mint an admin JWT using AUTH_SECRET from .env.local.
//   2. POST /api/admin/reassign-leads in `preview` mode — a dry-run
//      that returns wouldReassign + sample without touching DB.
//   3. POST /api/admin/reassign-rules in `preview` mode with one rule
//      ("any → any rep") to confirm the second endpoint also lives.
//   4. Assert each returns 200 with a sensible body. No writes.
//
// Run: node scripts/_smoke-reassign.mjs [base-url]
// Defaults to https://calistamind.com — pass http://localhost:3000
// to hit dev.

import { readFileSync } from "node:fs";
import { SignJWT } from "jose";

const BASE = process.argv[2] ?? "https://calistamind.com";
const env = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
const local = {};
for (const l of env.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) local[m[1]] = m[2];
}
const SECRET = new TextEncoder().encode(local.AUTH_SECRET);
if (!local.AUTH_SECRET) {
  console.error("missing AUTH_SECRET in .env.local");
  process.exit(2);
}

async function mintAdmin() {
  // repId 5 = Xingze, who is admin in prod sales_reps.
  return new SignJWT({ repId: 5, role: "admin", repName: "Smoke-admin", email: "smoke@e.com" })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(SECRET);
}

async function post(path, body, token) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      cookie: `qiji_session=${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  return { status: r.status, json };
}

async function get(path, token) {
  const r = await fetch(`${BASE}${path}`, { headers: { cookie: `qiji_session=${token}` } });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

const failures = [];
function check(label, cond, detail = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!cond) failures.push(label);
}

console.log(`\n[reassign smoke] base=${BASE}`);
const token = await mintAdmin();

// Sanity: confirm the JWT actually logs in as admin.
const me = await get("/api/auth/me", token);
check("auth/me returns 200", me.status === 200, `status=${me.status}`);
check("auth/me role=admin", me.json?.role === "admin", `role=${me.json?.role}`);

// Resolve any active rep id for the smoke target.
const repsRes = await get("/api/sales-reps", token);
check("sales-reps returns 200", repsRes.status === 200, `status=${repsRes.status}`);
const firstActive = (repsRes.json?.reps ?? []).find((r) => r.active !== false);
check("at least one active rep exists", !!firstActive, `name=${firstActive?.name}`);
const toRepId = firstActive?.id;

// 1. /api/admin/reassign-leads — preview mode, no writes.
console.log("\n[reassign-leads preview]");
const preview = await post(
  "/api/admin/reassign-leads",
  {
    mode: "preview",
    toRepId,
    // Filter to a tiny slice: leads currently assigned to nobody +
    // status=skipped. wouldReassign will be small or zero; the point
    // is the endpoint answers 200 with the right shape.
    filter: { status: "skipped" },
  },
  token,
);
console.log("  status:", preview.status);
console.log("  body:", JSON.stringify(preview.json, null, 2).slice(0, 600));
check("reassign-leads preview status 200", preview.status === 200);
check("preview has wouldReassign", typeof preview.json?.wouldReassign === "number");
check("preview did NOT actually reassign", preview.json?.reassigned === 0, `reassigned=${preview.json?.reassigned}`);
check("preview returned targetRep", !!preview.json?.targetRep, `name=${preview.json?.targetRep?.name}`);

// 2. /api/admin/reassign-rules — preview mode, no writes.
console.log("\n[reassign-rules preview]");
const rules = await post(
  "/api/admin/reassign-rules",
  {
    mode: "preview",
    rules: [{ when: { geo: "cn" }, toRepId }],
  },
  token,
);
console.log("  status:", rules.status);
console.log("  body:", JSON.stringify(rules.json, null, 2).slice(0, 600));
check("reassign-rules preview status 200", rules.status === 200);
check("rules.totalLeads is a number", typeof rules.json?.totalLeads === "number");
check("rules.perRule is an array", Array.isArray(rules.json?.perRule));
check("rules.perRule[0].toRepName present", !!rules.json?.perRule?.[0]?.toRepName);

console.log("\n[summary]");
if (failures.length === 0) {
  console.log("  ✓ reassign API end-to-end OK\n");
  process.exit(0);
} else {
  console.log(`  ✗ ${failures.length} failures:`);
  for (const f of failures) console.log("    -", f);
  process.exit(1);
}
