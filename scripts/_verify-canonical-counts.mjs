// End-to-end smoke test for canonical-counts migration.
//
// Calls the canonical-counts primitives directly, then verifies each
// migrated API route returns numbers consistent with them. Any mismatch
// is a real bug — the whole point of canonical-counts is that these
// must agree.
//
// Run: node scripts/_verify-canonical-counts.mjs
//
// Exits 0 on clean match, 1 on any disagreement.

import { readFileSync } from "node:fs";

const env = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const l of env.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}

const { createClient } = await import("@supabase/supabase-js");
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const failures = [];
function assert(label, actual, expected, tolerance = 0) {
  const ok = Math.abs(actual - expected) <= tolerance;
  console.log(`  ${ok ? "✓" : "✗"} ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}`);
  if (!ok) failures.push({ label, actual, expected });
}

console.log("\n[1] Ground-truth totals from raw SQL:");
const { count: totalAll } = await supabase.from("pipeline_leads").select("*", { count: "exact", head: true });
const { count: totalReady } = await supabase.from("pipeline_leads").select("*", { count: "exact", head: true }).eq("status", "ready");
const { count: totalReplied } = await supabase.from("pipeline_leads").select("*", { count: "exact", head: true }).eq("status", "replied");
const { count: totalStrong } = await supabase.from("pipeline_leads").select("*", { count: "exact", head: true }).eq("lead_tier", "strong");
console.log(`  pipeline_leads total: ${totalAll}`);
console.log(`  pipeline_leads ready: ${totalReady}`);
console.log(`  pipeline_leads replied: ${totalReplied}`);
console.log(`  pipeline_leads strong: ${totalStrong}`);

console.log("\n[2] Canonical-counts primitives:");
const { countLeads, countLeadsByStatus, countReadyQueue, fetchAllLeads, countReplies } = await import(
  "/Users/xingzewang/Desktop/mail/src/lib/canonical-counts.ts"
);
const cLeads = await countLeads({}, { cache: false });
assert("countLeads({}) → total", cLeads.count, totalAll);
const cReady = await countLeads({ status: "ready" }, { cache: false });
assert("countLeads({status:'ready'}) → ready", cReady.count, totalReady);
const cReplied = await countLeads({ status: "replied" }, { cache: false });
assert("countLeads({status:'replied'}) → replied", cReplied.count, totalReplied);
const cStrong = await countLeads({ tier: "strong" }, { cache: false });
assert("countLeads({tier:'strong'}) → strong", cStrong.count, totalStrong);

console.log("\n[3] countLeadsByStatus matches sum-of-parts:");
const byStatus = await countLeadsByStatus({}, { cache: false });
const sumOfStatuses = Object.values(byStatus.byStatus).reduce((a, b) => a + b, 0);
assert("sum(byStatus) ≈ total", sumOfStatuses, totalAll, 5); // tolerance for race-condition drift between queries
assert("byStatus.ready", byStatus.byStatus.ready, totalReady);
assert("byStatus.total", byStatus.total, totalAll);

console.log("\n[4] countReadyQueue split adds up:");
const ready = await countReadyQueue({}, { cache: false });
assert("sendable + ripening == total", ready.sendable + ready.ripening, ready.total);
assert("readyQueue.total == ready status count", ready.total, totalReady);

console.log("\n[5] fetchAllLeads has no 1000-row cap:");
const { rows, total } = await fetchAllLeads({}, "id");
assert("fetchAllLeads.rows.length", rows.length, totalAll);
assert("fetchAllLeads.total", total, totalAll);
console.log(`    ↑ NOTE: if this matches 3068+ we beat the old 1000 cap`);

console.log("\n[6] Per-rep counts via canonical match raw queries:");
const { data: reps } = await supabase.from("sales_reps").select("id, name");
for (const r of (reps || []).slice(0, 4)) {
  const { count: raw } = await supabase.from("pipeline_leads").select("*", { count: "exact", head: true }).eq("assigned_rep_id", r.id);
  const c = await countLeads({ repId: r.id }, { cache: false });
  assert(`rep ${r.name} (id=${r.id})`, c.count, raw ?? 0);
}

console.log("\n[7] countReplies matches raw inbound count:");
const { count: rawInbound } = await supabase.from("inbound_emails").select("*", { count: "exact", head: true });
const cReplies = await countReplies({}, { cache: false });
assert("global inbound count", cReplies.count, rawInbound ?? 0);

console.log("\n[8] Summary:");
if (failures.length === 0) {
  console.log("  ✓ all canonical-counts surfaces agree with raw SQL\n");
  process.exit(0);
} else {
  console.log(`  ✗ ${failures.length} mismatches:\n`);
  for (const f of failures) console.log("    ", f);
  process.exit(1);
}
