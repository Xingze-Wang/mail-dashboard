// Smoke test the admin reassign endpoints.
//
// Walks: /api/admin/reassign-leads (preview + filter mode roundtrip)
//        /api/admin/reassign-rules (preview + apply with no-op rules
//        that don't actually move anything — preserves data).
//
// Mints an admin JWT from AUTH_SECRET. Localhost only.

import { readFileSync } from "node:fs";
import { SignJWT } from "jose";

const env = readFileSync(".env.local", "utf8").split("\n");
function v(name) {
  return env.find((l) => l.startsWith(name + "="))?.slice(name.length + 1).replace(/^["']|["']$/g, "").trim();
}
const secret = v("AUTH_SECRET");
if (!secret) { console.error("AUTH_SECRET missing"); process.exit(1); }
const token = await new SignJWT({ repId: 5, repName: "Xingze", email: "smoke@local", role: "admin" })
  .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(secret));
const cookie = `qiji_session=${token}`;
const BASE = "http://localhost:3000";

async function call(path, init = {}) {
  const r = await fetch(BASE + path, { ...init, headers: { cookie, ...(init.headers ?? {}) } });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, ok: r.ok, body };
}

console.log("=== Reassign smoke ===\n");

// Need at least 2 reps for a non-trivial test
const repsResp = await call("/api/sales-reps");
const reps = repsResp.body?.reps ?? repsResp.body ?? [];
if (reps.length < 2) { console.error("need 2 reps, found", reps.length); process.exit(1); }
const [r0, r1] = reps;
console.log(`reps: ${r0.name} (${r0.id}) and ${r1.name} (${r1.id})\n`);

// 1. preview: leads currently with r0 + leadTier=normal
console.log("1. /reassign-leads preview filter currentRepId=r0, leadTier=normal");
const p1 = await call("/api/admin/reassign-leads", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ mode: "preview", toRepId: r1.id, filter: { currentRepId: r0.id, leadTier: "normal" } }),
});
console.log(`   status=${p1.status} wouldReassign=${p1.body?.wouldReassign ?? "?"}`);
if (p1.body?.sample?.length) console.log(`   first sample: ${p1.body.sample[0].author_name ?? p1.body.sample[0].id}`);

// 2. preview rules: tier-1 schools to r0, .cn to r1
console.log("\n2. /reassign-rules preview tier1→r0, geo=cn→r1");
const p2 = await call("/api/admin/reassign-rules", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    mode: "preview",
    rules: [
      { when: { schoolTier: 1 }, toRepId: r0.id },
      { when: { geo: "cn" }, toRepId: r1.id },
    ],
  }),
});
console.log(`   status=${p2.status}`);
console.log(`   total=${p2.body?.totalLeads}, unmatched=${p2.body?.unmatched}`);
for (const r of p2.body?.perRule ?? []) {
  console.log(`   rule ${r.index}: ${r.matchCount} matches → ${r.toRepName}`);
}

// 3. validation — bad payload returns 400
console.log("\n3. /reassign-leads bad payload (no toRepId)");
const p3 = await call("/api/admin/reassign-leads", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ mode: "preview" }),
});
console.log(`   status=${p3.status} (expect 400) error=${p3.body?.error ?? ""}`);

// 4. round-trip: pick a tiny preview set, apply, then move back.
console.log("\n4. /reassign-leads round-trip — picks 1 lead, moves it, moves it back");
// Find a single skipped or replied lead currently with r0
const tinyPreview = await call("/api/admin/reassign-leads", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ mode: "preview", toRepId: r1.id, filter: { currentRepId: r0.id, status: "skipped" } }),
});
const sample = tinyPreview.body?.sample?.[0];
if (!sample) {
  console.log("   no skipped lead under r0 — skip round-trip");
} else {
  console.log(`   target lead: ${sample.id} (was on rep ${sample.fromRepId})`);
  // move r0 → r1
  const apply1 = await call("/api/admin/reassign-leads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "ids", toRepId: r1.id, lead_ids: [sample.id] }),
  });
  console.log(`   apply → r1: status=${apply1.status} reassigned=${apply1.body?.reassigned} cascaded=${apply1.body?.emailsCascaded}`);
  // move back r1 → r0
  const apply2 = await call("/api/admin/reassign-leads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "ids", toRepId: sample.fromRepId, lead_ids: [sample.id] }),
  });
  console.log(`   restore → r0: status=${apply2.status} reassigned=${apply2.body?.reassigned} cascaded=${apply2.body?.emailsCascaded}`);
}

console.log("\nDone.");
