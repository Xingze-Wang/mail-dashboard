/**
 * Integration test: rep_daily_quotas CRUD via quota-store helpers.
 * Run: node scripts/test-rep-quotas.mjs
 */
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const TEST_REP_ID = Number(process.env.TEST_REP_ID || 1);
const TODAY = new Date().toISOString().slice(0, 10);
const TOMORROW = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

let pass = 0, fail = 0;
const assert = (cond, msg) => {
  if (cond) { console.log(`  ✓ ${msg}`); pass++; }
  else { console.error(`  ✗ ${msg}`); fail++; }
};

const snap = await sb
  .from("rep_daily_quotas")
  .select("per_pool, direction_priority")
  .eq("rep_id", TEST_REP_ID)
  .maybeSingle();
const originalPerPool = snap.data?.per_pool ?? null;
const originalDirPri = snap.data?.direction_priority ?? [];

console.log("\nTest 1: getEffectiveQuota uses standing quota when no override");
{
  const { getEffectiveQuota } = await import("../src/lib/quota-store.ts");
  const q = await getEffectiveQuota(TEST_REP_ID, TODAY);
  assert(q !== null, "returns non-null quota");
  assert(typeof q.per_pool.strong === "number", "per_pool.strong is a number");
}

console.log("\nTest 2: setStandingQuota persists per_pool");
{
  const { setStandingQuota, getEffectiveQuota } = await import("../src/lib/quota-store.ts");
  await setStandingQuota(TEST_REP_ID, {
    per_pool: { strong: 99, normal_cn: 1, normal_overseas: 2, normal_edu: 3 },
    direction_priority: ["world_models"],
    updated_by_rep_id: TEST_REP_ID,
  });
  const q = await getEffectiveQuota(TEST_REP_ID, TODAY);
  assert(q.per_pool.strong === 99, "strong=99 round-trips");
  assert(q.per_pool.normal_cn === 1, "normal_cn=1 round-trips");
  assert(q.direction_priority[0] === "world_models", "direction_priority round-trips");
}

console.log("\nTest 3: override for tomorrow takes precedence");
{
  const { setOverride, getEffectiveQuota } = await import("../src/lib/quota-store.ts");
  await setOverride(TEST_REP_ID, TOMORROW, {
    per_pool: { strong: 0, normal_cn: 0, normal_overseas: 0, normal_edu: 0 },
    reason: "PTO",
    created_by_rep_id: TEST_REP_ID,
  });
  const q = await getEffectiveQuota(TEST_REP_ID, TOMORROW);
  assert(q.per_pool.strong === 0, "override strong=0 wins over standing strong=99");
  assert(q.per_pool.normal_cn === 0, "override normal_cn=0 wins");
}

// Restore
if (originalPerPool) {
  const { setStandingQuota } = await import("../src/lib/quota-store.ts");
  await setStandingQuota(TEST_REP_ID, {
    per_pool: originalPerPool,
    direction_priority: originalDirPri,
    updated_by_rep_id: null,
  });
}
await sb.from("rep_daily_quotas_override").delete().eq("rep_id", TEST_REP_ID).eq("due_date", TOMORROW);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
