// Prod end-to-end smoke for canonical-counts.
//
// Hits every migrated user-facing route on calistamind.com with both
// admin and rep JWTs, then verifies that the numbers each returns are
// internally consistent (the same count of the same thing under the
// same scope agrees across surfaces).
//
// Run: node scripts/_smoke-prod-canonical-counts.mjs

import { readFileSync } from "node:fs";
import { SignJWT } from "jose";

// Use .env.local (not vercel env pull) — the latter adds a literal `\n`
// suffix inside the quoted value that breaks JWT signing. Local .env.local
// has the same secret without the trailing bytes.
const env = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
const prodEnv = {};
for (const l of env.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) prodEnv[m[1]] = m[2];
}
const SECRET = new TextEncoder().encode(prodEnv.AUTH_SECRET);

async function mintToken(claims) {
  return new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setExpirationTime("1h").sign(SECRET);
}

async function hit(path, token, attempt = 0) {
  try {
    const r = await fetch(`https://calistamind.com${path}`, {
      headers: { cookie: `qiji_session=${token}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) return { _status: r.status, _error: await r.text() };
    return r.json();
  } catch (err) {
    if (attempt < 2) {
      console.log(`    retry ${attempt + 1} on ${path}: ${err.message?.slice(0, 50)}`);
      await new Promise((r) => setTimeout(r, 2000));
      return hit(path, token, attempt + 1);
    }
    return { _status: 0, _error: String(err).slice(0, 100) };
  }
}

const adminToken = await mintToken({ repId: 5, role: "admin", repName: "Smoke", email: "smoke@e.com" });
const yujieToken = await mintToken({ repId: 2, role: "sales", repName: "Yujie", email: "yujie@e.com" });
const leoToken = await mintToken({ repId: 1, role: "sales", repName: "Leo", email: "leo@e.com" });

const failures = [];
function check(label, lhs, rhs, tolerance = 0) {
  const ok = Math.abs(lhs - rhs) <= tolerance;
  console.log(`  ${ok ? "✓" : "✗"} ${label}: ${lhs} === ${rhs}`);
  if (!ok) failures.push({ label, lhs, rhs });
}

console.log("\n[Admin scope] — global numbers should agree across surfaces");
const aPipe = await hit("/api/pipeline?limit=1000", adminToken);
const aAnalytics = await hit("/api/pipeline/analytics", adminToken);
const aReady = await hit("/api/pipeline/ready-count", adminToken);
const aMetrics = await hit("/api/metrics", adminToken);

console.log(`  pipeline.total: ${aPipe.total}`);
console.log(`  analytics.channels.totalLeads: ${aAnalytics.channels?.totalLeads}`);
console.log(`  metrics.pipeline.total: ${aMetrics.pipeline?.total}`);
console.log(`  metrics.pipeline.ready: ${aMetrics.pipeline?.ready}`);
console.log(`  ready.count: ${aReady.count} (readyNow ${aReady.readyNow} + ripening ${aReady.ripening})`);

check("pipeline.total == analytics.totalLeads", aPipe.total, aAnalytics.channels?.totalLeads);
check("pipeline.total == metrics.pipeline.total", aPipe.total, aMetrics.pipeline?.total);
check("metrics.pipeline.ready == ready-count", aMetrics.pipeline?.ready, aReady.count);
check("ready split adds up", aReady.readyNow + aReady.ripening, aReady.count);

console.log("\n[Yujie scope] — rep-scoped numbers should also agree");
const yPipe = await hit("/api/pipeline?limit=1000", yujieToken);
const yAnalytics = await hit("/api/pipeline/analytics", yujieToken);
const yReady = await hit("/api/pipeline/ready-count", yujieToken);
const yMe = await hit("/api/metrics/me", yujieToken);
const yUnread = await hit("/api/inbox/unread-count", yujieToken);

console.log(`  pipeline.total: ${yPipe.total}`);
console.log(`  analytics.channels.totalLeads: ${yAnalytics.channels?.totalLeads}`);
console.log(`  metrics/me.assigned: ${yMe.assigned}`);
console.log(`  metrics/me.ready: ${yMe.ready}`);
console.log(`  ready.count: ${yReady.count}`);
console.log(`  unread: ${yUnread.count}`);

check("Yujie pipeline.total == analytics.totalLeads", yPipe.total, yAnalytics.channels?.totalLeads);
check("Yujie pipeline.total == metrics/me.assigned", yPipe.total, yMe.assigned);
check("Yujie ready-count == metrics/me.ready", yReady.count, yMe.ready);

console.log("\n[Leo scope]");
const lPipe = await hit("/api/pipeline?limit=1000", leoToken);
const lMe = await hit("/api/metrics/me", leoToken);
const lUnread = await hit("/api/inbox/unread-count", leoToken);
console.log(`  pipeline.total: ${lPipe.total}`);
console.log(`  metrics/me.assigned: ${lMe.assigned}`);
console.log(`  unread: ${lUnread.count}`);
check("Leo pipeline.total == metrics/me.assigned", lPipe.total, lMe.assigned);

console.log("\n[Per-rep sum should match global total]");
let perRepSum = 0;
const repTokens = [
  { id: 1, name: "Leo" },
  { id: 2, name: "Yujie" },
  { id: 3, name: "Ethan" },
  { id: 5, name: "Xingze" },
  { id: 7, name: "Xuwen" },
  { id: 10, name: "李金阳" },
  { id: 11, name: "王泽群" },
];
for (const r of repTokens) {
  const tok = await mintToken({ repId: r.id, role: "sales", repName: r.name, email: "smoke@e.com" });
  const m = await hit("/api/metrics/me", tok);
  const n = m.assigned ?? 0;
  perRepSum += n;
  console.log(`  rep ${r.name}: assigned=${n}`);
}
console.log(`  sum: ${perRepSum}, global: ${aPipe.total}`);
// Unassigned leads exist (assigned_rep_id = NULL after the shared-pool migration),
// so per-rep sum will be <= global total. Verify the gap looks reasonable.
const gap = aPipe.total - perRepSum;
console.log(`  unassigned pool size (inferred): ${gap}`);
if (gap < 0) failures.push({ label: "per-rep sum > global", lhs: perRepSum, rhs: aPipe.total });
else console.log(`  ✓ per-rep sum ≤ global (gap is unassigned pool)`);

console.log("\n[Summary]");
if (failures.length === 0) {
  console.log(`  ✓ all ${repTokens.length + 3} prod surfaces agree\n`);
  process.exit(0);
} else {
  console.log(`  ✗ ${failures.length} disagreements:\n`);
  for (const f of failures) console.log("    ", f);
  process.exit(1);
}
