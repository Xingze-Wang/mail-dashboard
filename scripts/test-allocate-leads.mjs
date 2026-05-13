/**
 * Integration test: allocator picks leads from v_lead_pool by pool_key.
 * Run in shadow mode (writes allocation_log but does NOT set assigned_rep_id).
 * Run: npx tsx --env-file=.env.local scripts/test-allocate-leads.mjs
 */
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

let pass = 0, fail = 0;
const assert = (cond, msg) => {
  if (cond) { console.log(`  ✓ ${msg}`); pass++; }
  else { console.error(`  ✗ ${msg}`); fail++; }
};
const TODAY = new Date().toISOString().slice(0, 10);

console.log("\nTest 1: pickCandidatesForPool returns leads of right pool_key");
{
  const { pickCandidatesForPool } = await import("../src/lib/allocator.ts");
  const leads = await pickCandidatesForPool("normal_cn", 5, []);
  assert(Array.isArray(leads), "returns array");
  assert(leads.length <= 5, `returns ≤5 (got ${leads.length})`);
  assert(leads.every((l) => l.pool_key === "normal_cn"), "all leads are normal_cn");
}

console.log("\nTest 2: pickCandidatesForPool with n=0 returns []");
{
  const { pickCandidatesForPool } = await import("../src/lib/allocator.ts");
  const leads = await pickCandidatesForPool("strong", 0, []);
  assert(Array.isArray(leads) && leads.length === 0, "n=0 → empty array");
}

console.log("\nTest 3: allocateForRep in shadow mode writes log but NOT assigned_rep_id");
{
  const { allocateForRep } = await import("../src/lib/allocator.ts");
  const TEST_REP_ID = Number(process.env.TEST_REP_ID || 2);  // Yujie = normal_cn
  // Seed a temporary active send mission for today if none exists
  let missionId;
  const m = await sb.from("missions").select("id").eq("rep_id", TEST_REP_ID).eq("due_date", TODAY).eq("kind", "send").eq("status", "active").maybeSingle();
  if (m.data) {
    missionId = m.data.id;
  } else {
    const ins = await sb.from("missions").insert({
      rep_id: TEST_REP_ID, due_date: TODAY, kind: "send", target: 2,
      scope: { per_pool: { strong: 0, normal_cn: 2, normal_overseas: 0, normal_edu: 0 } },
      status: "active", generated_by: "heuristic",
    }).select("id").maybeSingle();
    if (ins.error) {
      console.error(`could not create test mission: ${ins.error.message}`);
      process.exit(1);
    }
    missionId = ins.data.id;
  }

  const result = await allocateForRep({
    mission_id: missionId,
    rep_id: TEST_REP_ID,
    due_date: TODAY,
    per_pool: { strong: 0, normal_cn: 2, normal_overseas: 0, normal_edu: 0 },
    direction_priority: [],
    allocator: "test:shadow",
    shadow: true,
  });
  assert(result.total_allocated >= 0, "returns total_allocated count");
  assert(Array.isArray(result.lead_ids), "returns lead_ids array");

  // Shadow check: those leads should NOT have assigned_rep_id set
  if (result.lead_ids.length > 0) {
    const check = await sb.from("pipeline_leads").select("id, assigned_rep_id").in("id", result.lead_ids);
    const allNull = (check.data || []).every((r) => r.assigned_rep_id === null);
    assert(allNull, "shadow mode left assigned_rep_id NULL");
  }

  // allocation_log row written
  const log = await sb.from("allocation_log").select("id, lead_ids").eq("mission_id", missionId).eq("due_date", TODAY).eq("allocator", "test:shadow");
  assert((log.data?.length || 0) > 0, "allocation_log row written");

  // Cleanup test allocation_log rows
  await sb.from("allocation_log").delete().eq("allocator", "test:shadow");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
