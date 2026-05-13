# Shared Lead Pool + Mission-Driven Daily Allocation + Mission UX — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move per-lead rep assignment from import-time (`assignRep()` in import route) to a daily allocation cron driven by admin-set per-rep daily quotas, with sub-pool partitioning and explicit Lark DM notifications when each rep's leads land. Simultaneously fix the mission system's UI invisibility (sidebar link, /pipeline banner, onboarding walkthrough, MissionsDot empty-state).

**Architecture:** Import route writes `assigned_rep_id = NULL`. A new cron `/api/missions/allocate-leads` runs at 09:00 Beijing, reads each rep's active `send` mission (`target` + `scope.per_pool`), pulls leads from sub-pools (strong / normal_cn / normal_overseas / normal_edu) via a new SQL view `v_lead_pool`, sets `assigned_rep_id`, writes an audit row to `allocation_log`, and DMs the rep. Admin quotas live in a new `rep_daily_quotas` table, set via a new panel on `/admin/missions`. The mission system gets a sidebar link, a `/pipeline` banner, MissionsDot empty-states, and an onboarding walkthrough mention.

**Tech Stack:** Next.js 16, TypeScript, Supabase (Postgres + service-role client), Vercel cron, Lark messenger via `src/lib/lark.ts:sendMessage`. No test framework exists in this repo — verification uses standalone Node scripts (`scripts/test-*.mjs`) following the existing pattern (e.g. `scripts/test-dedup-gate.mjs`).

**Spec reference:** `docs/superpowers/specs/2026-05-13-shared-pool-and-mission-ux-design.md`

**Migration number:** 082 (verified: 081 is current latest).

**Important corrections to spec:**
- Spec mentioned `lark_user_id` in places — the actual column is `sales_reps.lark_open_id` (migration 067 et al). All notification paths use `lark_open_id`.
- Spec said current latest migration is 069; actual is 081. Migration in this plan is `082`.

---

## File map

**New files:**
- `migrations/082-shared-pool-allocation.sql` — all schema additions in one migration
- `scripts/apply-082.mjs` — runner following `scripts/apply-081.mjs` shape
- `scripts/test-allocate-leads.mjs` — integration test for the allocator
- `scripts/test-rep-quotas.mjs` — integration test for quota CRUD
- `src/lib/allocator.ts` — pure allocation algorithm (one mission → leads)
- `src/lib/quota-store.ts` — reads/writes `rep_daily_quotas` + override table
- `src/app/api/missions/allocate-leads/route.ts` — cron + admin trigger
- `src/app/api/admin/missions/quotas/route.ts` — GET + POST quota panel
- `src/app/api/admin/allocation/override/route.ts` — per-rep re-allocate
- `src/app/admin/allocation/page.tsx` — admin allocation cockpit
- `src/components/missions-banner.tsx` — `/pipeline` banner component

**Modified files:**
- `src/app/api/pipeline/import/route.ts` — stop calling `assignRep()`, write `assigned_rep_id: null`
- `src/app/api/missions/heuristic-seed/route.ts` — source target from quotas instead of `clamp(ready_count, 5, 12)`
- `src/components/sidebar.tsx` — add `/missions` to `mainNav` and `/admin/missions` to `toolsNav`
- `src/components/missions-dot.tsx` — empty-state for new reps + green check when all done
- `src/app/pipeline/page.tsx` — render `<MissionsBanner />` above the stat strip
- `src/app/admin/missions/page.tsx` — add Daily Quotas panel at top
- `src/lib/onboarding.ts` — update Message 2 and Message 4 walkthrough text
- `src/lib/helper-read-tools.ts` — add `get_my_missions_today` tool
- `vercel.json` — change `heuristic-seed` schedule, add `allocate-leads` schedule

**No-touch:** `src/lib/assignment.ts` (`assignRep()` stays callable for admin auto-route), `src/lib/template-assembler.ts`, the templates layer, `emails` table, attribution columns.

---

## Task ordering principles

Tasks are ordered so each one leaves the system in a working state:

1. **Schema first** (Task 1–2) — additive only, doesn't change behavior
2. **Pure-function libs** (Task 3–4) — testable in isolation, no wiring
3. **Quota panel** (Task 5–7) — admin can set quotas; no allocation yet
4. **Allocation cron in shadow** (Task 8–10) — runs but doesn't write `assigned_rep_id`
5. **Notification** (Task 11) — Lark DM step, still shadow
6. **UI surfacing** (Task 12–15) — visible mission entry points
7. **Onboarding** (Task 16) — walkthrough integration
8. **Phase 2 flip** (Task 17–18) — import stops calling `assignRep()`; cron writes
9. **Verification** (Task 19) — week of observation, success-criteria sample checks

---

## Task 1: Migration 082 — schema additions

**Files:**
- Create: `migrations/082-shared-pool-allocation.sql`
- Create: `scripts/apply-082.mjs`

- [ ] **Step 1: Write the migration SQL**

Create `migrations/082-shared-pool-allocation.sql` with this exact content:

```sql
-- migrations/082-shared-pool-allocation.sql
--
-- 1. SCHEMA CHANGE
-- Adds three tables and one view for shared-pool allocation:
--   - rep_daily_quotas: standing per-rep per-pool daily quota set by admin
--   - rep_daily_quotas_override: one-shot quota overrides for a single date
--   - allocation_log: append-only audit trail of every lead allocation
--   - v_lead_pool: VIEW exposing unassigned leads tagged by sub-pool key
--
-- 2. WHO WRITES THIS?
-- rep_daily_quotas: POST /api/admin/missions/quotas (admin UI)
-- rep_daily_quotas_override: POST /api/admin/missions/quotas (override path)
-- allocation_log: GET/POST /api/missions/allocate-leads (cron + admin trigger)
--                 and POST /api/admin/allocation/override (per-rep re-allocate)
-- v_lead_pool: not written — derived view
--
-- 3. WHO READS THIS?
-- rep_daily_quotas: GET /api/admin/missions/quotas (panel), heuristic-seed cron
-- rep_daily_quotas_override: heuristic-seed cron (overrides standing quota for that date)
-- allocation_log: GET /api/admin/allocation (cockpit), allocate-leads (idempotency)
-- v_lead_pool: allocate-leads cron, GET /api/admin/allocation (pool inventory)
--
-- 4. BACKFILL FOR OLD ROWS
-- rep_daily_quotas: (a) one-shot INSERT in this migration seeds a row per
--   currently-active sales rep mirroring today's routing (Leo all-strong,
--   Yujie all-cn, Ethan all-overseas, Chenyu small-cn). Numbers below are
--   conservative defaults; admin can edit immediately from /admin/missions.
-- rep_daily_quotas_override: (d) not applicable — new table, no legacy rows
-- allocation_log: (d) not applicable — new table, no legacy rows
-- v_lead_pool: (d) not applicable — view, computed on read
--
-- Reference: docs/DATA_INTEGRITY_PLAN.md Tier 4

CREATE TABLE IF NOT EXISTS rep_daily_quotas (
  rep_id integer PRIMARY KEY REFERENCES sales_reps(id) ON DELETE CASCADE,
  per_pool jsonb NOT NULL DEFAULT '{}'::jsonb,
  direction_priority text[] NOT NULL DEFAULT ARRAY[]::text[],
  updated_by_rep_id integer REFERENCES sales_reps(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rep_daily_quotas_override (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id integer NOT NULL REFERENCES sales_reps(id) ON DELETE CASCADE,
  due_date date NOT NULL,
  per_pool jsonb NOT NULL,
  reason text,
  created_by_rep_id integer REFERENCES sales_reps(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(rep_id, due_date)
);
CREATE INDEX IF NOT EXISTS idx_rep_daily_quotas_override_date
  ON rep_daily_quotas_override(due_date DESC);

CREATE TABLE IF NOT EXISTS allocation_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id uuid REFERENCES missions(id),
  rep_id integer NOT NULL REFERENCES sales_reps(id),
  due_date date NOT NULL,
  pool_key text NOT NULL,
  lead_ids uuid[] NOT NULL,
  allocator text NOT NULL,
  reason text,
  notification_status text,
  notification_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_allocation_log_due_date
  ON allocation_log(due_date DESC);
CREATE INDEX IF NOT EXISTS idx_allocation_log_rep
  ON allocation_log(rep_id, due_date DESC);

CREATE OR REPLACE VIEW v_lead_pool AS
SELECT
  id,
  person_id,
  author_email,
  author_name,
  lead_tier,
  school_tier,
  citation_count,
  h_index,
  matched_directions,
  local_score,
  CASE
    WHEN author_email ILIKE '%.cn' OR author_email ILIKE '%.cn.%' THEN 'cn'
    WHEN author_email ILIKE '%.edu' OR author_email ILIKE '%.edu.%' THEN 'edu'
    ELSE 'other'
  END AS geo,
  CASE
    WHEN lead_tier = 'strong' THEN 'strong'
    WHEN lead_tier = 'normal' AND (author_email ILIKE '%.cn' OR author_email ILIKE '%.cn.%') THEN 'normal_cn'
    WHEN lead_tier = 'normal' AND (author_email ILIKE '%.edu' OR author_email ILIKE '%.edu.%') THEN 'normal_edu'
    ELSE 'normal_overseas'
  END AS pool_key,
  created_at
FROM pipeline_leads
WHERE assigned_rep_id IS NULL
  AND status IN ('new', 'queued')
  AND skipped_at IS NULL;

-- Backfill: seed rep_daily_quotas for currently active sales reps.
-- Conservative starting numbers; admin will tune from /admin/missions.
-- We use a CTE so the migration is idempotent (re-run safe).
INSERT INTO rep_daily_quotas (rep_id, per_pool)
SELECT id, CASE
  WHEN lower(name) = 'leo'    THEN '{"strong":8,"normal_cn":0,"normal_overseas":0,"normal_edu":0}'::jsonb
  WHEN lower(name) = 'yujie'  THEN '{"strong":0,"normal_cn":12,"normal_overseas":0,"normal_edu":0}'::jsonb
  WHEN lower(name) = 'ethan'  THEN '{"strong":0,"normal_cn":0,"normal_overseas":10,"normal_edu":2}'::jsonb
  WHEN lower(name) = 'chenyu' THEN '{"strong":0,"normal_cn":6,"normal_overseas":0,"normal_edu":0}'::jsonb
  ELSE '{"strong":0,"normal_cn":0,"normal_overseas":0,"normal_edu":0}'::jsonb
END
FROM sales_reps
WHERE active = true
  AND id NOT IN (SELECT rep_id FROM rep_daily_quotas);
```

- [ ] **Step 2: Write the apply runner**

Create `scripts/apply-082.mjs`, modeled on `scripts/apply-081.mjs`:

```javascript
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://erguqrisqtugfysofwdd.supabase.co";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_SERVICE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY env var required");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const sql = readFileSync("migrations/082-shared-pool-allocation.sql", "utf8");
const { error } = await sb.rpc("_exec_sql", { sql_text: sql });
if (error) {
  console.error("FAIL:", error.message);
  process.exit(1);
}

// Probe 1: rep_daily_quotas rows
const probe1 = await sb
  .from("rep_daily_quotas")
  .select("rep_id, per_pool")
  .order("rep_id");
if (probe1.error) {
  console.error("Probe quotas failed:", probe1.error.message);
  process.exit(1);
}
console.log("OK: rep_daily_quotas seeded:");
for (const r of probe1.data || []) {
  console.log(`  rep_id=${r.rep_id} per_pool=${JSON.stringify(r.per_pool)}`);
}

// Probe 2: v_lead_pool exists and returns rows
const probe2 = await sb.from("v_lead_pool").select("id, pool_key").limit(3);
if (probe2.error) {
  console.error("Probe v_lead_pool failed:", probe2.error.message);
  process.exit(1);
}
console.log(`OK: v_lead_pool returns ${probe2.data?.length ?? 0} sample rows`);

// Probe 3: allocation_log and rep_daily_quotas_override tables exist
const probe3a = await sb.from("allocation_log").select("id").limit(1);
const probe3b = await sb.from("rep_daily_quotas_override").select("id").limit(1);
if (probe3a.error) {
  console.error("Probe allocation_log failed:", probe3a.error.message);
  process.exit(1);
}
if (probe3b.error) {
  console.error("Probe override failed:", probe3b.error.message);
  process.exit(1);
}
console.log("OK: allocation_log + rep_daily_quotas_override tables exist");
```

- [ ] **Step 3: Run migration locally against prod DB**

Run: `SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY node scripts/apply-082.mjs`

Expected output (numbers may vary by team size):
```
OK: rep_daily_quotas seeded:
  rep_id=1 per_pool={"strong":8,"normal_cn":0,"normal_overseas":0,"normal_edu":0}
  rep_id=2 per_pool={"strong":0,"normal_cn":12,"normal_overseas":0,"normal_edu":0}
  rep_id=3 per_pool={"strong":0,"normal_cn":0,"normal_overseas":10,"normal_edu":2}
  rep_id=N per_pool={"strong":0,"normal_cn":6,"normal_overseas":0,"normal_edu":0}
OK: v_lead_pool returns 3 sample rows
OK: allocation_log + rep_daily_quotas_override tables exist
```

If the rep names in your DB don't match Leo/Yujie/Ethan/Chenyu (case-insensitive), they'll get the ELSE fallback `{0,0,0,0}` — admin will need to set quotas manually from the UI before allocation can run for them.

- [ ] **Step 4: Commit**

```bash
git add migrations/082-shared-pool-allocation.sql scripts/apply-082.mjs
git commit -m "migration(082): shared-pool allocation tables + v_lead_pool view

Adds rep_daily_quotas, rep_daily_quotas_override, allocation_log tables
and v_lead_pool view. Seeds initial quotas mirroring today's routing.
No code reads these yet — wired up in subsequent commits."
```

---

## Task 2: Type definitions for new tables

**Files:**
- Create: `src/lib/pool-types.ts`

- [ ] **Step 1: Define shared types**

Create `src/lib/pool-types.ts`:

```typescript
/**
 * Type definitions for the shared-pool allocation system.
 * Imported by allocator.ts, quota-store.ts, and route handlers.
 */

export type PoolKey = "strong" | "normal_cn" | "normal_overseas" | "normal_edu";

export const POOL_KEYS: readonly PoolKey[] = [
  "strong",
  "normal_cn",
  "normal_overseas",
  "normal_edu",
] as const;

export interface PerPool {
  strong: number;
  normal_cn: number;
  normal_overseas: number;
  normal_edu: number;
}

export const ZERO_PER_POOL: PerPool = {
  strong: 0,
  normal_cn: 0,
  normal_overseas: 0,
  normal_edu: 0,
};

export interface RepDailyQuota {
  rep_id: number;
  per_pool: PerPool;
  direction_priority: string[];
  updated_by_rep_id: number | null;
  updated_at: string;
}

export interface RepDailyQuotaOverride {
  id: string;
  rep_id: number;
  due_date: string; // ISO date
  per_pool: PerPool;
  reason: string | null;
  created_by_rep_id: number | null;
  created_at: string;
}

export interface AllocationLogRow {
  id: string;
  mission_id: string | null;
  rep_id: number;
  due_date: string;
  pool_key: PoolKey;
  lead_ids: string[];
  allocator: string; // 'cron' | 'admin:{rep_id}'
  reason: string | null;
  notification_status: "sent" | "failed" | "skipped_no_lark" | null;
  notification_sent_at: string | null;
  created_at: string;
}

export interface PoolLeadCandidate {
  id: string;
  person_id: string | null;
  author_email: string;
  author_name: string | null;
  lead_tier: "strong" | "normal";
  school_tier: number | null;
  citation_count: number | null;
  h_index: number | null;
  matched_directions: string | null;
  local_score: number | null;
  geo: "cn" | "edu" | "other";
  pool_key: PoolKey;
  created_at: string;
}

export function sumPerPool(p: PerPool): number {
  return p.strong + p.normal_cn + p.normal_overseas + p.normal_edu;
}

export function normalizePerPool(raw: unknown): PerPool {
  if (!raw || typeof raw !== "object") return { ...ZERO_PER_POOL };
  const r = raw as Record<string, unknown>;
  const num = (k: string) => {
    const v = r[k];
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
  };
  return {
    strong: num("strong"),
    normal_cn: num("normal_cn"),
    normal_overseas: num("normal_overseas"),
    normal_edu: num("normal_edu"),
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/pool-types.ts
git commit -m "feat(pool): type definitions for shared-pool allocation"
```

---

## Task 3: Quota store library

**Files:**
- Create: `src/lib/quota-store.ts`
- Create: `scripts/test-rep-quotas.mjs`

- [ ] **Step 1: Write the failing integration test**

Create `scripts/test-rep-quotas.mjs`:

```javascript
/**
 * Integration test: rep_daily_quotas CRUD via quota-store helpers.
 * Run: SUPABASE_SERVICE_ROLE_KEY=... node scripts/test-rep-quotas.mjs
 */
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.SUPABASE_URL || "https://erguqrisqtugfysofwdd.supabase.co",
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

// Use a test rep_id that exists. Default 1 (Leo).
const TEST_REP_ID = Number(process.env.TEST_REP_ID || 1);
const TODAY = new Date().toISOString().slice(0, 10);
const TOMORROW = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

let pass = 0, fail = 0;
const assert = (cond, msg) => {
  if (cond) { console.log(`  ✓ ${msg}`); pass++; }
  else { console.error(`  ✗ ${msg}`); fail++; }
};

// Snapshot current quota to restore later.
const snap = await sb
  .from("rep_daily_quotas")
  .select("per_pool, direction_priority")
  .eq("rep_id", TEST_REP_ID)
  .maybeSingle();
const originalPerPool = snap.data?.per_pool ?? null;

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
    direction_priority: snap.data.direction_priority || [],
    updated_by_rep_id: null,
  });
}
await sb.from("rep_daily_quotas_override").delete().eq("rep_id", TEST_REP_ID).eq("due_date", TOMORROW);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY node scripts/test-rep-quotas.mjs`

Expected: FAIL with "Cannot find module '../src/lib/quota-store.ts'" or similar.

- [ ] **Step 3: Write `quota-store.ts`**

Create `src/lib/quota-store.ts`:

```typescript
/**
 * Read/write helpers for rep_daily_quotas and rep_daily_quotas_override.
 * The "effective" quota for (rep, date) is: override row if present, else standing quota.
 */

import { supabase } from "@/lib/db";
import {
  type PerPool,
  type RepDailyQuota,
  type RepDailyQuotaOverride,
  normalizePerPool,
  ZERO_PER_POOL,
} from "@/lib/pool-types";

export interface EffectiveQuota {
  rep_id: number;
  per_pool: PerPool;
  direction_priority: string[];
  source: "standing" | "override";
}

/**
 * Get the effective quota for a rep on a given date.
 * Override row wins over standing quota. Returns ZERO_PER_POOL quota
 * if rep has no row at all (caller should treat that as "skip rep").
 */
export async function getEffectiveQuota(
  repId: number,
  dueDate: string,
): Promise<EffectiveQuota> {
  // Check override first
  const ov = await supabase
    .from("rep_daily_quotas_override")
    .select("per_pool")
    .eq("rep_id", repId)
    .eq("due_date", dueDate)
    .maybeSingle();
  if (ov.data?.per_pool) {
    return {
      rep_id: repId,
      per_pool: normalizePerPool(ov.data.per_pool),
      direction_priority: [], // overrides don't carry direction priority
      source: "override",
    };
  }

  // Fall back to standing quota
  const st = await supabase
    .from("rep_daily_quotas")
    .select("per_pool, direction_priority")
    .eq("rep_id", repId)
    .maybeSingle();
  if (st.data) {
    return {
      rep_id: repId,
      per_pool: normalizePerPool(st.data.per_pool),
      direction_priority: Array.isArray(st.data.direction_priority)
        ? st.data.direction_priority.filter((s): s is string => typeof s === "string")
        : [],
      source: "standing",
    };
  }

  // Rep has no quota at all
  return {
    rep_id: repId,
    per_pool: { ...ZERO_PER_POOL },
    direction_priority: [],
    source: "standing",
  };
}

/** Get effective quotas for all active reps on a date. */
export async function getAllEffectiveQuotas(dueDate: string): Promise<EffectiveQuota[]> {
  const reps = await supabase
    .from("sales_reps")
    .select("id")
    .eq("active", true);
  if (reps.error || !reps.data) return [];
  return Promise.all(reps.data.map((r) => getEffectiveQuota(r.id, dueDate)));
}

export async function setStandingQuota(
  repId: number,
  input: {
    per_pool: PerPool;
    direction_priority?: string[];
    updated_by_rep_id: number | null;
  },
): Promise<void> {
  const { error } = await supabase.from("rep_daily_quotas").upsert(
    {
      rep_id: repId,
      per_pool: normalizePerPool(input.per_pool),
      direction_priority: input.direction_priority ?? [],
      updated_by_rep_id: input.updated_by_rep_id,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "rep_id" },
  );
  if (error) throw new Error(`setStandingQuota failed: ${error.message}`);
}

export async function setOverride(
  repId: number,
  dueDate: string,
  input: {
    per_pool: PerPool;
    reason?: string | null;
    created_by_rep_id: number | null;
  },
): Promise<void> {
  const { error } = await supabase.from("rep_daily_quotas_override").upsert(
    {
      rep_id: repId,
      due_date: dueDate,
      per_pool: normalizePerPool(input.per_pool),
      reason: input.reason ?? null,
      created_by_rep_id: input.created_by_rep_id,
    },
    { onConflict: "rep_id,due_date" },
  );
  if (error) throw new Error(`setOverride failed: ${error.message}`);
}

export async function listStandingQuotas(): Promise<RepDailyQuota[]> {
  const { data, error } = await supabase
    .from("rep_daily_quotas")
    .select("*")
    .order("rep_id");
  if (error || !data) return [];
  return data.map((r) => ({
    ...r,
    per_pool: normalizePerPool(r.per_pool),
    direction_priority: Array.isArray(r.direction_priority) ? r.direction_priority : [],
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY node scripts/test-rep-quotas.mjs`

Expected:
```
Test 1: getEffectiveQuota uses standing quota when no override
  ✓ returns non-null quota
  ✓ per_pool.strong is a number
Test 2: setStandingQuota persists per_pool
  ✓ strong=99 round-trips
  ✓ normal_cn=1 round-trips
  ✓ direction_priority round-trips
Test 3: override for tomorrow takes precedence
  ✓ override strong=0 wins over standing strong=99
  ✓ override normal_cn=0 wins

7 passed, 0 failed
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/quota-store.ts scripts/test-rep-quotas.mjs
git commit -m "feat(pool): rep_daily_quotas read/write helpers + integration test"
```

---

## Task 4: Allocator library (pure-ish algorithm)

**Files:**
- Create: `src/lib/allocator.ts`
- Create: `scripts/test-allocate-leads.mjs`

- [ ] **Step 1: Write the failing integration test**

Create `scripts/test-allocate-leads.mjs`:

```javascript
/**
 * Integration test: allocator picks leads from v_lead_pool by pool_key.
 * Run in shadow mode (writes allocation_log but does NOT set assigned_rep_id).
 * Run: SUPABASE_SERVICE_ROLE_KEY=... node scripts/test-allocate-leads.mjs
 */
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.SUPABASE_URL || "https://erguqrisqtugfysofwdd.supabase.co",
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

let pass = 0, fail = 0;
const assert = (cond, msg) => {
  if (cond) { console.log(`  ✓ ${msg}`); pass++; }
  else { console.error(`  ✗ ${msg}`); fail++; }
};

const TODAY = new Date().toISOString().slice(0, 10);

console.log("\nTest 1: pickCandidatesForPool returns up to N leads of right pool_key");
{
  const { pickCandidatesForPool } = await import("../src/lib/allocator.ts");
  const leads = await pickCandidatesForPool("normal_cn", 5, []);
  assert(Array.isArray(leads), "returns array");
  assert(leads.length <= 5, `returns ≤5 (got ${leads.length})`);
  assert(leads.every((l) => l.pool_key === "normal_cn"), "all leads are normal_cn");
}

console.log("\nTest 2: pickCandidatesForPool with empty pool returns empty array");
{
  const { pickCandidatesForPool } = await import("../src/lib/allocator.ts");
  // Use a tiny limit on a pool that may be empty
  const leads = await pickCandidatesForPool("normal_edu", 1, []);
  assert(Array.isArray(leads), "returns array even when pool is small");
}

console.log("\nTest 3: allocateForRep in shadow mode writes log but NOT assigned_rep_id");
{
  const { allocateForRep } = await import("../src/lib/allocator.ts");
  const TEST_REP_ID = Number(process.env.TEST_REP_ID || 1);
  // Make sure rep has a mission row to allocate against
  const m = await sb
    .from("missions")
    .select("id")
    .eq("rep_id", TEST_REP_ID)
    .eq("due_date", TODAY)
    .eq("kind", "send")
    .eq("status", "active")
    .maybeSingle();
  if (!m.data) {
    console.log("  (skip: no active send mission for rep — seed missions first)");
  } else {
    const result = await allocateForRep({
      mission_id: m.data.id,
      rep_id: TEST_REP_ID,
      due_date: TODAY,
      per_pool: { strong: 0, normal_cn: 2, normal_overseas: 0, normal_edu: 0 },
      direction_priority: [],
      allocator: "test:shadow",
      shadow: true,
    });
    assert(result.total_allocated >= 0, "returns total_allocated count");
    assert(Array.isArray(result.lead_ids), "returns lead_ids array");

    // Verify shadow: those leads should NOT have assigned_rep_id set
    if (result.lead_ids.length > 0) {
      const check = await sb
        .from("pipeline_leads")
        .select("id, assigned_rep_id")
        .in("id", result.lead_ids);
      const allNull = (check.data || []).every((r) => r.assigned_rep_id === null);
      assert(allNull, "shadow mode left assigned_rep_id NULL");
    }

    // Verify allocation_log row was written
    const log = await sb
      .from("allocation_log")
      .select("id, lead_ids")
      .eq("mission_id", m.data.id)
      .eq("due_date", TODAY)
      .eq("allocator", "test:shadow");
    assert((log.data?.length || 0) > 0, "allocation_log row written");

    // Cleanup test allocation_log rows
    await sb.from("allocation_log").delete().eq("allocator", "test:shadow");
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY node scripts/test-allocate-leads.mjs`

Expected: FAIL — "Cannot find module '../src/lib/allocator.ts'".

- [ ] **Step 3: Write `allocator.ts`**

Create `src/lib/allocator.ts`:

```typescript
/**
 * Lead allocator: given a mission (rep + per-pool quota), pick leads
 * from v_lead_pool and (in non-shadow mode) set assigned_rep_id.
 *
 * Stateless except for the DB calls. Pure algorithm sits in
 * pickCandidatesForPool; allocateForRep is the orchestration layer.
 */

import { supabase } from "@/lib/db";
import {
  type PerPool,
  type PoolKey,
  type PoolLeadCandidate,
  POOL_KEYS,
} from "@/lib/pool-types";

/**
 * Pick up to `n` leads from a sub-pool, prioritizing direction matches
 * (within strong pool only) and then citation count.
 *
 * @param poolKey   Which sub-pool to draw from
 * @param n         Max leads to return
 * @param directionPriority  Ordered list of `matched_directions` to prefer (strong pool only)
 */
export async function pickCandidatesForPool(
  poolKey: PoolKey,
  n: number,
  directionPriority: string[],
): Promise<PoolLeadCandidate[]> {
  if (n <= 0) return [];

  // We can't do a single SQL query for the priority logic across array
  // intersection cleanly via supabase-js, so we fetch a pool window
  // (3x n, capped at 100) and sort in code. The pool view is already
  // narrow (only unassigned new/queued), so this is cheap.
  const window = Math.min(Math.max(n * 3, 20), 100);

  const { data, error } = await supabase
    .from("v_lead_pool")
    .select(
      "id, person_id, author_email, author_name, lead_tier, school_tier, citation_count, h_index, matched_directions, local_score, geo, pool_key, created_at",
    )
    .eq("pool_key", poolKey)
    .order("created_at", { ascending: false })
    .limit(window);

  if (error || !data) return [];

  const candidates = data as unknown as PoolLeadCandidate[];

  // Compute priority score
  const scored = candidates.map((c) => {
    let score = 0;
    if (poolKey === "strong" && directionPriority.length > 0 && c.matched_directions) {
      // matched_directions is stored as comma-separated text
      const dirs = c.matched_directions.split(",").map((s) => s.trim()).filter(Boolean);
      const hit = directionPriority.findIndex((p) => dirs.includes(p));
      if (hit >= 0) score += 100 + (directionPriority.length - hit); // earlier priority = higher
    }
    score += (c.citation_count ?? 0) / 1000;
    return { lead: c, score };
  });

  scored.sort((a, b) => b.score - a.score || (b.lead.created_at > a.lead.created_at ? 1 : -1));

  return scored.slice(0, n).map((s) => s.lead);
}

export interface AllocateForRepInput {
  mission_id: string;
  rep_id: number;
  due_date: string;
  per_pool: PerPool;
  direction_priority: string[];
  allocator: string; // 'cron' | 'admin:{rep_id}' | 'test:shadow'
  shadow?: boolean; // if true, write allocation_log but NOT assigned_rep_id
  reason?: string | null;
}

export interface AllocateForRepResult {
  rep_id: number;
  mission_id: string;
  total_allocated: number;
  lead_ids: string[];
  per_pool_actual: PerPool; // what we actually allocated per pool
  underfilled: PoolKey[]; // pools where wanted > available
}

export async function allocateForRep(input: AllocateForRepInput): Promise<AllocateForRepResult> {
  const allLeadIds: string[] = [];
  const perPoolActual: PerPool = { strong: 0, normal_cn: 0, normal_overseas: 0, normal_edu: 0 };
  const underfilled: PoolKey[] = [];

  for (const pk of POOL_KEYS) {
    const want = input.per_pool[pk];
    if (want <= 0) continue;

    const picks = await pickCandidatesForPool(pk, want, input.direction_priority);
    perPoolActual[pk] = picks.length;
    if (picks.length < want) underfilled.push(pk);

    if (picks.length === 0) continue;

    const ids = picks.map((p) => p.id);
    allLeadIds.push(...ids);

    // Write allocation_log (always)
    const { error: logErr } = await supabase.from("allocation_log").insert({
      mission_id: input.mission_id,
      rep_id: input.rep_id,
      due_date: input.due_date,
      pool_key: pk,
      lead_ids: ids,
      allocator: input.allocator,
      reason: input.reason ?? null,
      notification_status: null,
    });
    if (logErr) {
      // log but continue — partial progress is better than partial rollback
      console.error(`[allocator] allocation_log insert failed for pool=${pk}: ${logErr.message}`);
    }

    // Set assigned_rep_id (unless shadow)
    if (!input.shadow) {
      const { error: updErr } = await supabase
        .from("pipeline_leads")
        .update({ assigned_rep_id: input.rep_id })
        .in("id", ids);
      if (updErr) {
        console.error(`[allocator] pipeline_leads update failed for pool=${pk}: ${updErr.message}`);
        // Don't throw — the log row already records what was intended.
      }
    }
  }

  return {
    rep_id: input.rep_id,
    mission_id: input.mission_id,
    total_allocated: allLeadIds.length,
    lead_ids: allLeadIds,
    per_pool_actual: perPoolActual,
    underfilled,
  };
}

/**
 * Check if this mission was already allocated today (idempotency).
 * Returns true if any allocation_log row exists for this mission on this date.
 */
export async function alreadyAllocated(missionId: string, dueDate: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("allocation_log")
    .select("id")
    .eq("mission_id", missionId)
    .eq("due_date", dueDate)
    .limit(1);
  if (error) return false;
  return (data?.length || 0) > 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY node scripts/test-allocate-leads.mjs`

Expected: all assertions pass. If "skip: no active send mission" appears, that's also acceptable — it means the seeder hasn't run yet (Task 10). You can manually create a test mission first:

```sql
INSERT INTO missions (rep_id, due_date, kind, target, scope, status, generated_by)
VALUES (1, CURRENT_DATE, 'send', 2, '{"per_pool":{"strong":0,"normal_cn":2,"normal_overseas":0,"normal_edu":0}}', 'active', 'admin');
```

then re-run the test.

- [ ] **Step 5: Commit**

```bash
git add src/lib/allocator.ts scripts/test-allocate-leads.mjs
git commit -m "feat(pool): allocator with pickCandidatesForPool + allocateForRep (shadow-capable)"
```

---

## Task 5: Quota API endpoints

**Files:**
- Create: `src/app/api/admin/missions/quotas/route.ts`

- [ ] **Step 1: Write the route**

Create `src/app/api/admin/missions/quotas/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { supabase } from "@/lib/db";
import {
  getAllEffectiveQuotas,
  setStandingQuota,
  setOverride,
} from "@/lib/quota-store";
import { normalizePerPool } from "@/lib/pool-types";

/** GET: return current standing quotas + reps. */
export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "admin only" }, { status: 403 });
  }

  const today = new Date().toISOString().slice(0, 10);

  const reps = await supabase
    .from("sales_reps")
    .select("id, name, sender_email, role, active, created_at")
    .eq("active", true)
    .order("id");
  if (reps.error) {
    return NextResponse.json({ error: reps.error.message }, { status: 500 });
  }

  const quotas = await getAllEffectiveQuotas(today);
  const quotaByRep = new Map(quotas.map((q) => [q.rep_id, q]));

  return NextResponse.json({
    today,
    reps: (reps.data || []).map((r) => ({
      rep_id: r.id,
      name: r.name,
      sender_email: r.sender_email,
      role: r.role,
      created_at: r.created_at,
      quota: quotaByRep.get(r.id) ?? null,
    })),
  });
}

/** POST: upsert standing quota OR override.
 *  Body for standing:  { rep_id, per_pool, direction_priority? }
 *  Body for override:  { rep_id, due_date, per_pool, reason? }
 */
export async function POST(req: NextRequest) {
  const session = await requireSession(req);
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "admin only" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const repId = Number(body.rep_id);
  if (!Number.isFinite(repId) || repId <= 0) {
    return NextResponse.json({ error: "rep_id required" }, { status: 400 });
  }
  const perPool = normalizePerPool(body.per_pool);

  if (body.due_date && typeof body.due_date === "string") {
    // Override path
    await setOverride(repId, body.due_date, {
      per_pool: perPool,
      reason: typeof body.reason === "string" ? body.reason : null,
      created_by_rep_id: session.repId,
    });
    return NextResponse.json({ ok: true, mode: "override", rep_id: repId, due_date: body.due_date });
  }

  // Standing quota path
  const directionPriority = Array.isArray(body.direction_priority)
    ? body.direction_priority.filter((s): s is string => typeof s === "string")
    : undefined;
  await setStandingQuota(repId, {
    per_pool: perPool,
    direction_priority: directionPriority,
    updated_by_rep_id: session.repId,
  });
  return NextResponse.json({ ok: true, mode: "standing", rep_id: repId });
}
```

- [ ] **Step 2: Smoke test the route**

Start dev server (kill any existing process on :3000 first):

```bash
pkill -f "next dev" 2>/dev/null; npm run dev &
sleep 5
```

Get an admin session cookie (use existing login flow — or pull `AUTH_COOKIE` value from an authenticated browser session). Save it as `$ADMIN_COOKIE`.

Test GET:
```bash
curl -s http://localhost:3000/api/admin/missions/quotas -H "Cookie: AUTH_COOKIE=$ADMIN_COOKIE" | jq '.reps | map({rep_id, name, quota: .quota.per_pool})'
```

Expected: list of reps with their quotas. Each rep should show non-null `quota` (seeded in migration).

Test POST (standing quota update):
```bash
curl -s -X POST http://localhost:3000/api/admin/missions/quotas \
  -H "Cookie: AUTH_COOKIE=$ADMIN_COOKIE" \
  -H "Content-Type: application/json" \
  -d '{"rep_id":1,"per_pool":{"strong":10,"normal_cn":0,"normal_overseas":0,"normal_edu":0}}' \
  | jq
```

Expected: `{"ok": true, "mode": "standing", "rep_id": 1}`.

Verify it round-trips via GET. Then restore original quota (default Leo: strong=8).

- [ ] **Step 3: Commit**

```bash
git add src/app/api/admin/missions/quotas/route.ts
git commit -m "feat(pool): /api/admin/missions/quotas — GET + POST for standing + override"
```

---

## Task 6: Daily Quotas panel on /admin/missions

**Files:**
- Modify: `src/app/admin/missions/page.tsx`

- [ ] **Step 1: Read the current file**

Read `src/app/admin/missions/page.tsx` to confirm the top of the page structure. The current component starts around line 80 with `export default function AdminMissionsPage()`.

- [ ] **Step 2: Add the QuotaPanel component above the existing focuses section**

Edit `src/app/admin/missions/page.tsx`. Add this new section *inside* `AdminMissionsPage`, rendered above the existing "Proposed focus" cards. Add the component definition near the bottom of the file (just before the default export's render):

```tsx
// Place near the existing interface declarations
interface QuotaRow {
  rep_id: number;
  name: string;
  sender_email: string | null;
  role: string;
  created_at: string;
  quota: {
    per_pool: { strong: number; normal_cn: number; normal_overseas: number; normal_edu: number };
    direction_priority: string[];
    source: "standing" | "override";
  } | null;
}

// New component
function QuotaPanel() {
  const [rows, setRows] = useState<QuotaRow[]>([]);
  const [today, setToday] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState<Map<number, QuotaRow["quota"]>>(new Map());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/admin/missions/quotas", { credentials: "include", cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setRows(j.reps as QuotaRow[]);
      setToday(j.today as string);
      setDirty(new Map());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const onChange = (repId: number, key: keyof QuotaRow["quota"]["per_pool"], val: number) => {
    setDirty((prev) => {
      const m = new Map(prev);
      const existing = m.get(repId) ?? rows.find((r) => r.rep_id === repId)?.quota ?? null;
      if (!existing) return prev;
      m.set(repId, {
        ...existing,
        per_pool: { ...existing.per_pool, [key]: Math.max(0, Math.floor(val)) },
      });
      return m;
    });
  };

  const save = async (repId: number) => {
    const q = dirty.get(repId);
    if (!q) return;
    setSaving(repId);
    try {
      const r = await fetch("/api/admin/missions/quotas", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rep_id: repId, per_pool: q.per_pool }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: 16, color: "#94a3b8" }}>
        <Loader2 size={14} className="animate-spin" style={{ display: "inline-block", marginRight: 8 }} />
        Loading quotas…
      </div>
    );
  }
  if (error) {
    return <div style={{ padding: 16, color: "#f87171" }}>Quota load failed: {error}</div>;
  }

  return (
    <section style={{ marginBottom: 32, border: "1px solid #1e293b", borderRadius: 8, padding: 20 }}>
      <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>Daily quotas</h2>
      <p style={{ fontSize: 13, color: "#94a3b8", marginBottom: 16 }}>
        Each rep's daily lead allocation by sub-pool. Applies every weekday until changed.
        Saved here, read by the allocation cron at 09:00 Beijing.
      </p>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ borderBottom: "1px solid #1e293b", color: "#94a3b8", fontSize: 12, textAlign: "left" }}>
            <th style={{ padding: 8 }}>Rep</th>
            <th style={{ padding: 8, textAlign: "right" }}>Strong</th>
            <th style={{ padding: 8, textAlign: "right" }}>Normal CN</th>
            <th style={{ padding: 8, textAlign: "right" }}>Normal Overseas</th>
            <th style={{ padding: 8, textAlign: "right" }}>Normal EDU</th>
            <th style={{ padding: 8, textAlign: "right" }}>Total</th>
            <th style={{ padding: 8 }}></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const current = dirty.get(row.rep_id) ?? row.quota;
            const pp = current?.per_pool ?? { strong: 0, normal_cn: 0, normal_overseas: 0, normal_edu: 0 };
            const total = pp.strong + pp.normal_cn + pp.normal_overseas + pp.normal_edu;
            const isDirty = dirty.has(row.rep_id);
            const joinedDays = Math.floor(
              (Date.now() - new Date(row.created_at).getTime()) / 86_400_000,
            );
            const isRamping = joinedDays < 30 && row.role === "sales";
            return (
              <tr key={row.rep_id} style={{ borderBottom: "1px solid #0f172a" }}>
                <td style={{ padding: 8 }}>
                  {row.name}
                  {isRamping ? (
                    <span style={{ fontSize: 11, color: "#fbbf24", marginLeft: 8 }}>
                      ramping (day {joinedDays})
                    </span>
                  ) : null}
                </td>
                {(["strong", "normal_cn", "normal_overseas", "normal_edu"] as const).map((k) => (
                  <td key={k} style={{ padding: 4, textAlign: "right" }}>
                    <input
                      type="number"
                      min={0}
                      value={pp[k]}
                      onChange={(e) => onChange(row.rep_id, k, Number(e.target.value))}
                      style={{
                        width: 56, textAlign: "right",
                        background: "#0f172a", border: "1px solid #1e293b",
                        color: "#e2e8f0", padding: "4px 8px", borderRadius: 4,
                      }}
                    />
                  </td>
                ))}
                <td style={{ padding: 8, textAlign: "right", color: "#94a3b8" }}>{total}</td>
                <td style={{ padding: 8 }}>
                  {isDirty ? (
                    <button
                      onClick={() => void save(row.rep_id)}
                      disabled={saving === row.rep_id}
                      style={{
                        padding: "4px 10px", fontSize: 12,
                        background: "#10b981", color: "white",
                        border: "none", borderRadius: 4, cursor: "pointer",
                      }}
                    >
                      {saving === row.rep_id ? "Saving…" : "Save"}
                    </button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p style={{ fontSize: 11, color: "#64748b", marginTop: 12 }}>
        Today is <strong>{today}</strong>. The seed cron reads quotas at 07:00 Beijing; allocation runs at 09:00 Beijing.
      </p>
    </section>
  );
}
```

Then in the `AdminMissionsPage` component render, add `<QuotaPanel />` as the first section inside the main container (above the existing stat cards / focuses section).

- [ ] **Step 3: Smoke test in browser**

```bash
pkill -f "next dev" 2>/dev/null; npm run dev &
sleep 5
```

Open `http://localhost:3000/admin/missions` (logged in as admin). Verify the Daily Quotas table renders with each rep's current per-pool numbers. Edit one cell (e.g. change Yujie's normal_cn from 12 to 13). Click "Save". Reload the page. Confirm the change persisted. Restore it back to 12.

- [ ] **Step 4: Commit**

```bash
git add src/app/admin/missions/page.tsx
git commit -m "feat(pool): admin Daily Quotas panel on /admin/missions"
```

---

## Task 7: Sidebar link for /missions and /admin/missions

**Files:**
- Modify: `src/components/sidebar.tsx`

- [ ] **Step 1: Add the missions entries to mainNav and toolsNav**

In `src/components/sidebar.tsx` find `mainNav` (around line 177) and `toolsNav` (around line 183).

Locate the icon import block at the top of the file (the lucide icons). Add `Target` to the lucide-react import list (or use whichever icon convention the file uses for nav icons — match the existing pattern; if icons come from custom SVG modules, add a matching `MissionsIcon` import).

Update `mainNav`:

```typescript
const mainNav = [
  { href: "/",         label: t("nav.overview", locale), Icon: OverviewIcon },
  { href: "/missions", label: t("nav.missions", locale), Icon: MissionsIcon, badgeKey: "missions_incomplete" as const },
  { href: "/pipeline", label: t("nav.pipeline", locale), Icon: PipelineIcon, badgeKey: "ready"  as const },
  { href: "/emails",   label: t("nav.emails",   locale), Icon: EmailsIcon,   badgeKey: "unread" as const },
];
```

Update `toolsNav` (add `/admin/missions` and `/admin/allocation`, both adminOnly):

```typescript
const toolsNav = [
  { href: "/brief",            label: t("nav.brief",          locale), Icon: BriefIcon,           adminOnly: false },
  { href: "/analysis",         label: t("nav.insights",       locale), Icon: InsightsIcon,        adminOnly: false },
  { href: "/templates",        label: t("nav.templates",      locale), Icon: TemplatesIcon,       adminOnly: false },
  { href: "/admin/missions",   label: t("nav.adminMissions",  locale), Icon: AdminMissionsIcon,   adminOnly: true  },
  { href: "/admin/allocation", label: t("nav.adminAllocation",locale), Icon: AdminAllocationIcon, adminOnly: true  },
  { href: "/congress",         label: t("nav.congress",       locale), Icon: CongressIcon,        adminOnly: true  },
  { href: "/scorer",           label: t("nav.scorer",         locale), Icon: ScorerIcon,          adminOnly: true  },
  { href: "/bench",            label: t("nav.bench",          locale), Icon: BenchIcon,           adminOnly: true  },
  { href: "/drift",            label: t("nav.drift",          locale), Icon: DriftIcon,           adminOnly: true  },
];
```

If `MissionsIcon`, `AdminMissionsIcon`, `AdminAllocationIcon` don't exist as imports in this file, add this near the other icon imports — match the file's icon-import style. If the file uses `lucide-react`, use:

```typescript
import { Target as MissionsIcon, ClipboardList as AdminMissionsIcon, Shuffle as AdminAllocationIcon } from "lucide-react";
```

If the file uses custom SVG components (e.g. `<OverviewIcon />`), copy the pattern: define minimal inline SVGs at the bottom of the file (small `target` ring for missions, `clipboard` for admin missions, `shuffle` for allocation).

- [ ] **Step 2: Add the i18n keys**

Open `src/lib/i18n.ts`. The existing `nav.overview` and `nav.pipeline` entries are around lines 9–10. Add three new entries following the same format:

```typescript
"nav.missions":         { en: "Today",          zh: "今日" },
"nav.adminMissions":    { en: "Missions Admin", zh: "任务管理" },
"nav.adminAllocation":  { en: "Allocation",     zh: "分配" },
```

- [ ] **Step 3: Wire the badge**

The sidebar currently fetches badge counts somewhere (likely from `/api/sidebar/badges` or as part of `/api/auth/me`). Find that fetch and add `missions_incomplete` to the response. If no badge endpoint exists, the simplest approach is to extend `useEffect` in sidebar.tsx to fetch `/api/missions` and count `incomplete = my_today.filter(m => (m.progress_count ?? 0) < m.target).length`.

Add (near the existing badge state):

```typescript
const [missionsIncomplete, setMissionsIncomplete] = useState(0);

useEffect(() => {
  let cancelled = false;
  const load = async () => {
    try {
      const r = await fetch("/api/missions", { credentials: "include", cache: "no-store" });
      if (!r.ok) return;
      const j = await r.json();
      if (cancelled) return;
      const open = (j.my_today || []).filter(
        (m: { progress_count?: number; target: number }) =>
          (m.progress_count ?? 0) < m.target,
      ).length;
      setMissionsIncomplete(open);
    } catch { /* silent — same posture as MissionsDot */ }
  };
  void load();
  const t = setInterval(() => void load(), 60_000);
  return () => { cancelled = true; clearInterval(t); };
}, []);
```

Then in the `NavItem` render for `missions`, pass `badge={missionsIncomplete}`. Match the existing badge-passing pattern used for `ready` and `unread`.

- [ ] **Step 4: Smoke test**

Restart dev server. Log in as a non-admin sales rep with an active mission. Confirm:
- "今日" appears in the left sidebar above "/pipeline"
- Click it → lands on `/missions`
- If the rep has incomplete missions, a small numeric badge shows on the nav item

Log in as admin. Confirm "任务管理" and "分配" appear in toolsNav.

- [ ] **Step 5: Commit**

```bash
git add src/components/sidebar.tsx
# also any i18n files modified
git commit -m "feat(missions): sidebar links for /missions, /admin/missions, /admin/allocation"
```

---

## Task 8: Allocation cron route (shadow mode)

**Files:**
- Create: `src/app/api/missions/allocate-leads/route.ts`

- [ ] **Step 1: Write the route**

Create `src/app/api/missions/allocate-leads/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { allocateForRep, alreadyAllocated } from "@/lib/allocator";
import { getEffectiveQuota } from "@/lib/quota-store";
import { sumPerPool } from "@/lib/pool-types";
import { requireSession } from "@/lib/auth-helpers";

export const preferredRegion = ["hkg1"];
export const maxDuration = 300;

interface RunResult {
  due_date: string;
  shadow: boolean;
  per_rep: Array<{
    rep_id: number;
    rep_name: string;
    mission_id: string | null;
    skipped_reason?: string;
    total_allocated?: number;
    per_pool_actual?: Record<string, number>;
    underfilled?: string[];
  }>;
}

async function runAllocation(shadow: boolean, allocator: string): Promise<RunResult> {
  const today = new Date().toISOString().slice(0, 10);
  const result: RunResult = { due_date: today, shadow, per_rep: [] };

  // Fetch active reps with send missions today
  const missions = await supabase
    .from("missions")
    .select("id, rep_id, target, scope")
    .eq("due_date", today)
    .eq("kind", "send")
    .eq("status", "active");
  if (missions.error) throw new Error(`missions query failed: ${missions.error.message}`);

  // Resolve rep names for log readability
  const repIds = (missions.data || []).map((m) => m.rep_id);
  const reps = repIds.length
    ? await supabase.from("sales_reps").select("id, name").in("id", repIds)
    : { data: [] as Array<{ id: number; name: string }>, error: null };
  const nameById = new Map((reps.data || []).map((r) => [r.id, r.name]));

  for (const m of missions.data || []) {
    const entry = {
      rep_id: m.rep_id,
      rep_name: nameById.get(m.rep_id) ?? `rep_${m.rep_id}`,
      mission_id: m.id as string,
    } as RunResult["per_rep"][number];

    // Idempotency: skip if already allocated today
    if (await alreadyAllocated(m.id as string, today)) {
      entry.skipped_reason = "already_allocated";
      result.per_rep.push(entry);
      continue;
    }

    // Resolve per_pool: prefer mission.scope.per_pool, else look up quota
    let perPool: { strong: number; normal_cn: number; normal_overseas: number; normal_edu: number } | null = null;
    let directionPriority: string[] = [];

    const scope = m.scope as { per_pool?: unknown; direction_priority?: unknown } | null;
    if (scope && typeof scope === "object" && scope.per_pool) {
      const { normalizePerPool } = await import("@/lib/pool-types");
      perPool = normalizePerPool(scope.per_pool);
      if (Array.isArray(scope.direction_priority)) {
        directionPriority = scope.direction_priority.filter((s): s is string => typeof s === "string");
      }
    } else {
      const q = await getEffectiveQuota(m.rep_id, today);
      perPool = q.per_pool;
      directionPriority = q.direction_priority;
    }

    if (!perPool || sumPerPool(perPool) === 0) {
      entry.skipped_reason = "zero_quota";
      result.per_rep.push(entry);
      continue;
    }

    const r = await allocateForRep({
      mission_id: m.id as string,
      rep_id: m.rep_id,
      due_date: today,
      per_pool: perPool,
      direction_priority: directionPriority,
      allocator,
      shadow,
    });
    entry.total_allocated = r.total_allocated;
    entry.per_pool_actual = r.per_pool_actual;
    entry.underfilled = r.underfilled;
    result.per_rep.push(entry);
  }

  return result;
}

/** GET — cron entry point. Auth: Bearer $CRON_SECRET. */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") || "";
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (!process.env.CRON_SECRET || auth !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // Cron runs in non-shadow mode (Phase 2 flip enables real writes).
  // For Phase 1 shadow rollout, set ALLOCATE_LEADS_SHADOW=true env var.
  const shadow = process.env.ALLOCATE_LEADS_SHADOW === "true";
  const result = await runAllocation(shadow, "cron");
  return NextResponse.json(result);
}

/** POST — admin trigger. */
export async function POST(req: NextRequest) {
  const session = await requireSession(req);
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "admin only" }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  const shadow = body.shadow === true;
  const result = await runAllocation(shadow, `admin:${session.repId}`);
  return NextResponse.json(result);
}
```

- [ ] **Step 2: Test the route in shadow mode**

Start dev. First ensure at least one active `send` mission exists for today; if not, insert one manually (see Task 4 SQL).

Trigger admin POST in shadow mode:
```bash
curl -s -X POST http://localhost:3000/api/missions/allocate-leads \
  -H "Cookie: AUTH_COOKIE=$ADMIN_COOKIE" \
  -H "Content-Type: application/json" \
  -d '{"shadow":true}' | jq
```

Expected: JSON listing each rep's intended allocation. Verify:
- `assigned_rep_id` on those leads is still NULL (run a `select` against `pipeline_leads`)
- `allocation_log` has rows with `allocator='admin:N'` for today

Clean up test allocation_log rows:
```sql
DELETE FROM allocation_log WHERE allocator LIKE 'admin:%' AND due_date = CURRENT_DATE;
```

- [ ] **Step 3: Wire the cron**

Edit `vercel.json`. Change the `heuristic-seed` schedule and add `allocate-leads`:

```json
{ "path": "/api/missions/heuristic-seed", "schedule": "0 23 * * 0-4" },
{ "path": "/api/missions/allocate-leads", "schedule": "0 1 * * 1-5" },
```

(The old `"0 2 * * *"` for heuristic-seed is replaced; allocate-leads is a new entry.)

- [ ] **Step 4: Commit**

```bash
git add src/app/api/missions/allocate-leads/route.ts vercel.json
git commit -m "feat(pool): /api/missions/allocate-leads cron route (shadow-capable)"
```

---

## Task 9: Update heuristic-seed to source from quotas

**Files:**
- Modify: `src/app/api/missions/heuristic-seed/route.ts`

- [ ] **Step 1: Read current heuristic-seed**

Open `src/app/api/missions/heuristic-seed/route.ts`. The current implementation computes `target = clamp(ready_count, 5, 12)` per rep. We replace that with: read each active rep's effective quota, set `target = sum(per_pool)`, set `scope = {per_pool, direction_priority}`, and create the mission as `status='active'` (auto-approved because admin-policy-sourced).

- [ ] **Step 2: Replace the seed logic**

In the function that computes per-rep send target (likely called `seedMissions` or similar), replace the body of the per-rep loop. The exact edit depends on current file structure — adapt this template. Key changes:

```typescript
import { getEffectiveQuota } from "@/lib/quota-store";
import { sumPerPool } from "@/lib/pool-types";

// ... inside the per-rep loop (replace the existing send-target computation):

const today = new Date().toISOString().slice(0, 10);

for (const rep of activeReps) {
  // Skip reps without a sender_email (fixes admin-phantom-mission bug)
  if (rep.role === "admin" && !rep.sender_email) continue;
  if (!rep.active) continue;

  const quota = await getEffectiveQuota(rep.id, today);
  const sendTarget = sumPerPool(quota.per_pool);
  if (sendTarget <= 0) {
    // No quota set → skip and notify admin (once per day)
    await maybeNotifyAdminMissingQuota(rep);
    continue;
  }

  // Check if mission already exists for today (idempotent re-runs)
  const existing = await supabase
    .from("missions")
    .select("id")
    .eq("rep_id", rep.id)
    .eq("due_date", today)
    .eq("kind", "send")
    .maybeSingle();
  if (existing.data) continue;

  await supabase.from("missions").insert({
    rep_id: rep.id,
    due_date: today,
    kind: "send",
    target: sendTarget,
    scope: {
      per_pool: quota.per_pool,
      direction_priority: quota.direction_priority,
    },
    status: "active",            // auto-approved — admin set the quota
    generated_by: "heuristic",   // (or change to 'admin_quota' if you prefer)
  });
}
```

Add the admin-notify helper near the top of the file. Because the seed cron runs once per day, we don't need cross-invocation dedup — a per-process `Set` is enough to prevent within-run duplicates if the seeder is ever re-entered:

```typescript
async function notifyAdminMissingQuota(rep: { id: number; name: string }): Promise<void> {
  const ADMIN_OPEN_ID = process.env.ADMIN_LARK_OPEN_ID;
  if (!ADMIN_OPEN_ID) return;
  const { sendMessage } = await import("@/lib/lark");
  await sendMessage({
    receive_id: ADMIN_OPEN_ID,
    receive_id_type: "open_id",
    text: `⚠️ ${rep.name} 今天没有 daily quota — 我跳过了 mission seed. 去 /admin/missions 设一下.`,
  }).catch(() => null);
}

// Use a module-scoped Set to dedup within a single cron invocation.
// (Cron runs once per day, so cross-invocation dedup is not needed.)
const notifiedThisRun = new Set<number>();
```

And inside the seed loop, the call becomes:
```typescript
if (sendTarget <= 0) {
  if (!notifiedThisRun.has(rep.id)) {
    await notifyAdminMissingQuota(rep);
    notifiedThisRun.add(rep.id);
  }
  continue;
}
```

If `ADMIN_LARK_OPEN_ID` env var is not set in your Vercel project, set it now: it's the admin's Lark `open_id` (e.g. starts with `ou_`). You can find your own via `SELECT lark_open_id FROM sales_reps WHERE role = 'admin' LIMIT 1;`.

- [ ] **Step 3: Verify by triggering manually**

Trigger heuristic-seed via admin POST:
```bash
curl -s -X POST http://localhost:3000/api/missions/heuristic-seed \
  -H "Cookie: AUTH_COOKIE=$ADMIN_COOKIE" | jq
```

Then check the DB:
```sql
SELECT rep_id, kind, target, scope, status
FROM missions
WHERE due_date = CURRENT_DATE AND kind = 'send'
ORDER BY rep_id;
```

Expected: each active rep with a non-zero quota has a row with `target = sum(per_pool)`, `scope.per_pool` populated, `status='active'`.

If you ran the seed during testing and want to reset, delete those rows then re-trigger:
```sql
DELETE FROM missions WHERE due_date = CURRENT_DATE AND generated_by = 'heuristic';
```

- [ ] **Step 4: Commit**

```bash
git add src/app/api/missions/heuristic-seed/route.ts
git commit -m "feat(pool): heuristic-seed reads admin quotas instead of clamp(ready_count)"
```

---

## Task 10: End-to-end shadow run

**Files:** none — verification only.

- [ ] **Step 1: Run heuristic-seed to create today's missions**

```bash
curl -s -X POST http://localhost:3000/api/missions/heuristic-seed \
  -H "Cookie: AUTH_COOKIE=$ADMIN_COOKIE" | jq
```

- [ ] **Step 2: Run allocate-leads in shadow mode**

```bash
curl -s -X POST http://localhost:3000/api/missions/allocate-leads \
  -H "Cookie: AUTH_COOKIE=$ADMIN_COOKIE" \
  -H "Content-Type: application/json" \
  -d '{"shadow":true}' | jq
```

- [ ] **Step 3: Inspect what would have happened**

```sql
SELECT
  rep_id,
  pool_key,
  array_length(lead_ids, 1) AS n_leads,
  allocator,
  created_at
FROM allocation_log
WHERE due_date = CURRENT_DATE
ORDER BY rep_id, pool_key;
```

Confirm distributions match quotas. For example if Yujie's quota is `{normal_cn: 12}`, expect a row `rep_id=2, pool_key=normal_cn, n_leads≤12`.

- [ ] **Step 4: Clean up the shadow log**

```sql
DELETE FROM allocation_log WHERE allocator LIKE 'admin:%' AND due_date = CURRENT_DATE;
```

No commit — this is verification.

---

## Task 11: Notification — Lark DM after allocation

**Files:**
- Create: `src/lib/allocation-notifier.ts`
- Modify: `src/app/api/missions/allocate-leads/route.ts`

- [ ] **Step 1: Write the notifier**

Create `src/lib/allocation-notifier.ts`:

```typescript
import { supabase } from "@/lib/db";
import type { PoolKey, PerPool } from "@/lib/pool-types";

const POOL_LABEL: Record<PoolKey, string> = {
  strong: "强势 (strong)",
  normal_cn: "国内 (normal CN)",
  normal_overseas: "海外 (normal overseas)",
  normal_edu: ".edu",
};

export interface NotifyInput {
  rep_id: number;
  due_date: string;
  per_pool_actual: PerPool;
  underfilled: PoolKey[];
  total_allocated: number;
}

/**
 * Send a per-rep DM summarizing today's allocation, then update
 * allocation_log.notification_status for the rep's rows on this date.
 */
export async function notifyRepOfAllocation(input: NotifyInput): Promise<"sent" | "failed" | "skipped_no_lark"> {
  if (input.total_allocated === 0) return "skipped_no_lark";

  const rep = await supabase
    .from("sales_reps")
    .select("name, lark_open_id")
    .eq("id", input.rep_id)
    .maybeSingle();
  if (!rep.data) return "failed";

  if (!rep.data.lark_open_id) {
    await markNotificationStatus(input.rep_id, input.due_date, "skipped_no_lark");
    return "skipped_no_lark";
  }

  // Build the message
  const lines: string[] = [];
  lines.push(`早上好 ${rep.data.name} 👋`);
  lines.push(``);
  lines.push(`今天给你分了 ${input.total_allocated} 条 lead, 都在 /pipeline 等着. AI 已经拟好草稿, 你看一眼 OK 就 Send.`);
  lines.push(``);
  lines.push(`分布:`);
  for (const [k, v] of Object.entries(input.per_pool_actual) as Array<[PoolKey, number]>) {
    if (v > 0) lines.push(`  • ${POOL_LABEL[k]}: ${v} 条`);
  }
  if (input.underfilled.length > 0) {
    lines.push(``);
    lines.push(`(${input.underfilled.map((k) => POOL_LABEL[k]).join(", ")} 池子今天不够, 我先给了你能给的. 其余明天再补.)`);
  }
  lines.push(``);
  lines.push(`开始: https://calistamind.com/pipeline`);
  lines.push(`今日任务: https://calistamind.com/missions`);

  try {
    const { sendMessage } = await import("@/lib/lark");
    const r = await sendMessage({
      receive_id: rep.data.lark_open_id,
      receive_id_type: "open_id",
      text: lines.join("\n"),
    });
    const ok = r && (r as { code?: number }).code === 0;
    await markNotificationStatus(input.rep_id, input.due_date, ok ? "sent" : "failed");
    return ok ? "sent" : "failed";
  } catch (err) {
    console.error(`[allocation-notifier] send failed for rep ${input.rep_id}:`, err);
    await markNotificationStatus(input.rep_id, input.due_date, "failed");
    return "failed";
  }
}

async function markNotificationStatus(
  repId: number,
  dueDate: string,
  status: "sent" | "failed" | "skipped_no_lark",
): Promise<void> {
  await supabase
    .from("allocation_log")
    .update({
      notification_status: status,
      notification_sent_at: status === "sent" ? new Date().toISOString() : null,
    })
    .eq("rep_id", repId)
    .eq("due_date", dueDate)
    .is("notification_status", null);
}
```

- [ ] **Step 2: Wire it into allocate-leads route**

Edit `src/app/api/missions/allocate-leads/route.ts`. After the `for (const m of missions.data || [])` loop completes, add a second pass for notifications (skip if shadow mode):

```typescript
// (after the per-mission allocation loop, before `return result;`)

if (!shadow) {
  const { notifyRepOfAllocation } = await import("@/lib/allocation-notifier");
  for (const entry of result.per_rep) {
    if (!entry.total_allocated || entry.total_allocated === 0) continue;
    if (entry.skipped_reason) continue;
    await notifyRepOfAllocation({
      rep_id: entry.rep_id,
      due_date: result.due_date,
      per_pool_actual: entry.per_pool_actual as PerPool,
      underfilled: (entry.underfilled || []) as PoolKey[],
      total_allocated: entry.total_allocated,
    }).catch((e) => {
      console.error(`[allocate-leads] notify failed for rep ${entry.rep_id}:`, e);
    });
  }
}
```

(Add `import type { PerPool, PoolKey } from "@/lib/pool-types";` at the top of the route file.)

- [ ] **Step 3: Test the notification path**

Manually invoke a real-mode allocation against a *test* rep. To avoid spamming the team Lark, do this:
- Temporarily set Yujie's `lark_open_id` to your own Lark `open_id` (`UPDATE sales_reps SET lark_open_id = '<your-open-id>' WHERE id = 2;`), and remember to restore after.
- Or, more conservatively, create a test rep row with your own `lark_open_id` and use that rep's id.

Then trigger:
```bash
curl -s -X POST http://localhost:3000/api/missions/allocate-leads \
  -H "Cookie: AUTH_COOKIE=$ADMIN_COOKIE" \
  -H "Content-Type: application/json" \
  -d '{"shadow":false}' | jq
```

Confirm:
- You receive the Lark DM with the correct breakdown
- `allocation_log.notification_status = 'sent'` for that rep's rows today

Roll back any test changes (restore Yujie's open_id, clean up test allocation_log + assigned_rep_id reverts).

- [ ] **Step 4: Commit**

```bash
git add src/lib/allocation-notifier.ts src/app/api/missions/allocate-leads/route.ts
git commit -m "feat(pool): Lark DM notification after allocation + status tracking"
```

---

## Task 12: MissionsBanner component on /pipeline

**Files:**
- Create: `src/components/missions-banner.tsx`
- Modify: `src/app/pipeline/page.tsx`

- [ ] **Step 1: Write the banner component**

Create `src/components/missions-banner.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Target, ArrowRight } from "lucide-react";

interface MyMission {
  id: string;
  kind: string;
  target: number;
  progress_count: number;
  status: string;
}

interface TeamFocus {
  theme: string;
  congress_run_id: string | null;
}

interface MissionsResponse {
  my_today: MyMission[];
  team_focus: TeamFocus | null;
}

const KIND_LABEL: Record<string, string> = {
  send: "sends",
  reply: "replies",
  mark_wechat: "wechat",
  review_proposals: "proposals",
  review_template_edits: "template edits",
  custom: "todos",
};

export default function MissionsBanner() {
  const [data, setData] = useState<MissionsResponse | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch("/api/missions", { credentials: "include", cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json()) as MissionsResponse;
        if (!cancelled) {
          setData(j);
          setLoaded(true);
        }
      } catch { /* silent */ }
    };
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (!loaded || !data) return null;
  const missions = data.my_today || [];
  if (missions.length === 0) return null;

  const allDone = missions.every((m) => (m.progress_count ?? 0) >= m.target);

  return (
    <Link
      href="/missions"
      style={{
        display: "flex", alignItems: "center", gap: 16,
        padding: "10px 16px", marginBottom: 12,
        background: allDone ? "rgba(16, 185, 129, 0.08)" : "rgba(99, 102, 241, 0.08)",
        border: `1px solid ${allDone ? "rgba(16, 185, 129, 0.2)" : "rgba(99, 102, 241, 0.2)"}`,
        borderRadius: 8, color: "#e2e8f0",
        fontSize: 14, textDecoration: "none",
      }}
    >
      {allDone ? <CheckCircle2 size={18} color="#10b981" /> : <Target size={18} color="#818cf8" />}
      <span style={{ fontWeight: 500 }}>Today:</span>
      <span style={{ color: "#94a3b8" }}>
        {missions.map((m, i) => (
          <span key={m.id}>
            {i > 0 ? " · " : ""}
            <span style={{ color: (m.progress_count ?? 0) >= m.target ? "#10b981" : "#e2e8f0" }}>
              {m.progress_count ?? 0}/{m.target}
            </span>{" "}
            {KIND_LABEL[m.kind] ?? m.kind}
          </span>
        ))}
      </span>
      {data.team_focus ? (
        <span style={{ marginLeft: "auto", color: "#94a3b8" }}>
          Focus: <span style={{ color: "#e2e8f0" }}>{data.team_focus.theme}</span>
        </span>
      ) : <span style={{ marginLeft: "auto" }} />}
      <ArrowRight size={14} color="#64748b" />
    </Link>
  );
}
```

- [ ] **Step 2: Render it on /pipeline**

Open `src/app/pipeline/page.tsx`. Near the top of the JSX render (above the stat strip), add:

```tsx
import MissionsBanner from "@/components/missions-banner";

// inside the component return, immediately before the stat strip:
<MissionsBanner />
```

- [ ] **Step 3: Smoke test**

```bash
pkill -f "next dev" 2>/dev/null; npm run dev &
sleep 5
```

Log in as a rep with active missions. Visit `/pipeline`. The banner should render above the stat strip showing "Today: N/M sends · ... · Focus: X". Click it → navigates to `/missions`. If the rep has no missions for today, the banner should be invisible.

- [ ] **Step 4: Commit**

```bash
git add src/components/missions-banner.tsx src/app/pipeline/page.tsx
git commit -m "feat(missions): /pipeline mission banner with progress + team focus"
```

---

## Task 13: MissionsDot empty-state

**Files:**
- Modify: `src/components/missions-dot.tsx`

- [ ] **Step 1: Update the visibility logic and rendering**

Open `src/components/missions-dot.tsx`. The current logic:

```typescript
if (!loaded || total === 0) return null;
if (incomplete === 0) return null;
```

Replace with a 4-state component. Read the full file first to confirm the existing variable names, then update:

```typescript
// At the top of the component, add `repCreatedAt` tracking by fetching from /api/auth/me
const [repCreatedAt, setRepCreatedAt] = useState<string | null>(null);

useEffect(() => {
  let cancelled = false;
  const load = async () => {
    try {
      const r = await fetch("/api/auth/me", { credentials: "include", cache: "no-store" });
      if (!r.ok) return;
      const j = await r.json();
      if (!cancelled && j.authenticated) setRepCreatedAt(j.repCreatedAt ?? null);
    } catch { /* silent */ }
  };
  void load();
  return () => { cancelled = true; };
}, []);

// Replace the bottom of the component:
if (!loaded) return null;
if (pathname?.startsWith("/login")) return null;

const isNewRep =
  repCreatedAt &&
  Date.now() - new Date(repCreatedAt).getTime() < 7 * 86_400_000;

if (total === 0 && !isNewRep) return null; // veterans on a quiet day — silent
if (total === 0 && isNewRep) {
  return (
    <Link
      href="/missions"
      style={{ /* same fixed-position styles, but greyer */
        position: "fixed", top: 16, right: 16,
        padding: "6px 12px", borderRadius: 16,
        background: "rgba(100, 116, 139, 0.12)",
        border: "1px solid rgba(100, 116, 139, 0.25)",
        color: "#94a3b8", fontSize: 12, textDecoration: "none",
        display: "flex", alignItems: "center", gap: 6,
      }}
      title="新员工: 今日任务即将出现"
    >
      <span>📋 今日任务即将出现</span>
    </Link>
  );
}
if (incomplete === 0) {
  // All done — show a quiet celebration pill
  return (
    <Link
      href="/missions"
      style={{
        position: "fixed", top: 16, right: 16,
        padding: "6px 12px", borderRadius: 16,
        background: "rgba(16, 185, 129, 0.12)",
        border: "1px solid rgba(16, 185, 129, 0.25)",
        color: "#10b981", fontSize: 12, textDecoration: "none",
        display: "flex", alignItems: "center", gap: 6,
      }}
      title="今日任务全部完成"
    >
      <span>✅ All done</span>
    </Link>
  );
}

// Default: incomplete > 0 — the existing red-dot rendering, unchanged
return (
  <Link href="/missions" /* …existing styles… */>
    {/* existing red dot + "Missions X/Y" markup */}
  </Link>
);
```

- [ ] **Step 2: Expose repCreatedAt on /api/auth/me**

Open `src/app/api/auth/me/route.ts` (or wherever `requireSession` builds the response). Add `created_at` from `sales_reps` to the returned JSON. The existing query likely already pulls `sales_reps.*`; just include `repCreatedAt: row.created_at` in the response. If `created_at` isn't pulled, add it to the SELECT list.

- [ ] **Step 3: Smoke test**

Log in as a rep with no missions and `created_at < 7d ago` (or temporarily set yours: `UPDATE sales_reps SET created_at = now() - interval '3 days' WHERE id = $YOUR_ID;`). Visit `/`. Expect: grey "📋 今日任务即将出现" pill in top-right.

Then create a mission for that rep and complete it (progress >= target). Expect: green "✅ All done".

Restore your `created_at` afterwards.

- [ ] **Step 4: Commit**

```bash
git add src/components/missions-dot.tsx src/app/api/auth/me/route.ts
git commit -m "feat(missions): MissionsDot empty-state for new reps + all-done celebration"
```

---

## Task 14: Admin allocation cockpit (/admin/allocation)

**Files:**
- Create: `src/app/admin/allocation/page.tsx`
- Create: `src/app/api/admin/allocation/route.ts`
- Create: `src/app/api/admin/allocation/override/route.ts`

- [ ] **Step 1: Inventory + today's allocations API**

Create `src/app/api/admin/allocation/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { supabase } from "@/lib/db";

export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "admin only" }, { status: 403 });
  }
  const today = new Date().toISOString().slice(0, 10);

  // Pool inventory: count v_lead_pool rows per pool_key
  // Supabase-js doesn't expose group_by directly via select; use rpc fallback OR
  // do 4 parallel head:true counts.
  const counts: Record<string, number> = {};
  for (const pk of ["strong", "normal_cn", "normal_overseas", "normal_edu"] as const) {
    const r = await supabase
      .from("v_lead_pool")
      .select("id", { count: "exact", head: true })
      .eq("pool_key", pk);
    counts[pk] = r.count ?? 0;
  }

  // Today's allocations
  const logs = await supabase
    .from("allocation_log")
    .select("rep_id, pool_key, lead_ids, allocator, notification_status, created_at")
    .eq("due_date", today)
    .order("created_at", { ascending: true });

  // Today's missions with targets
  const missions = await supabase
    .from("missions")
    .select("id, rep_id, target, scope, status")
    .eq("due_date", today)
    .eq("kind", "send");

  // Reps
  const reps = await supabase
    .from("sales_reps")
    .select("id, name, lark_open_id")
    .eq("active", true)
    .order("id");

  return NextResponse.json({
    today,
    pool_inventory: counts,
    allocations: logs.data || [],
    missions: missions.data || [],
    reps: reps.data || [],
  });
}
```

- [ ] **Step 2: Override API**

Create `src/app/api/admin/allocation/override/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { supabase } from "@/lib/db";
import { allocateForRep } from "@/lib/allocator";
import { normalizePerPool } from "@/lib/pool-types";

/**
 * POST body: { rep_id, per_pool, reason }
 * Effect: revoke today's existing allocation for this rep (return leads to
 * pool), re-run allocator with new per_pool, write new allocation_log
 * row with allocator='admin:N'.
 */
export async function POST(req: NextRequest) {
  const session = await requireSession(req);
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "admin only" }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  const repId = Number(body.rep_id);
  if (!Number.isFinite(repId) || repId <= 0) {
    return NextResponse.json({ error: "rep_id required" }, { status: 400 });
  }
  const perPool = normalizePerPool(body.per_pool);
  const reason = typeof body.reason === "string" ? body.reason : null;
  const today = new Date().toISOString().slice(0, 10);

  // Find today's mission for this rep
  const mission = await supabase
    .from("missions")
    .select("id")
    .eq("rep_id", repId)
    .eq("due_date", today)
    .eq("kind", "send")
    .maybeSingle();
  if (!mission.data) {
    return NextResponse.json({ error: "no send mission today for this rep" }, { status: 404 });
  }

  // Revoke prior allocations for this rep today: gather lead_ids, null them out, delete log rows.
  const prior = await supabase
    .from("allocation_log")
    .select("lead_ids")
    .eq("rep_id", repId)
    .eq("due_date", today);
  const priorLeadIds = (prior.data || []).flatMap((r) => r.lead_ids as string[]);
  if (priorLeadIds.length > 0) {
    await supabase.from("pipeline_leads").update({ assigned_rep_id: null }).in("id", priorLeadIds);
    await supabase.from("allocation_log").delete().eq("rep_id", repId).eq("due_date", today);
  }

  const result = await allocateForRep({
    mission_id: mission.data.id,
    rep_id: repId,
    due_date: today,
    per_pool: perPool,
    direction_priority: [],
    allocator: `admin:${session.repId}`,
    reason,
    shadow: false,
  });

  return NextResponse.json({ ok: true, result });
}
```

- [ ] **Step 3: Cockpit page**

Create `src/app/admin/allocation/page.tsx`:

```tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import { Loader2 } from "lucide-react";

interface PageData {
  today: string;
  pool_inventory: Record<string, number>;
  allocations: Array<{
    rep_id: number;
    pool_key: string;
    lead_ids: string[];
    allocator: string;
    notification_status: string | null;
    created_at: string;
  }>;
  missions: Array<{
    id: string;
    rep_id: number;
    target: number;
    scope: { per_pool?: Record<string, number> } | null;
    status: string;
  }>;
  reps: Array<{ id: number; name: string; lark_open_id: string | null }>;
}

export default function AdminAllocationPage() {
  const [data, setData] = useState<PageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch("/api/admin/allocation", { credentials: "include", cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData(await r.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const runNow = async () => {
    setRunning(true);
    try {
      const r = await fetch("/api/missions/allocate-leads", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shadow: false }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setRunning(false); }
  };

  if (loading) return <div style={{ padding: 24 }}><Loader2 size={14} className="animate-spin" /> Loading…</div>;
  if (error) return <div style={{ padding: 24, color: "#f87171" }}>Error: {error}</div>;
  if (!data) return null;

  const allocByRep = new Map<number, Array<typeof data.allocations[number]>>();
  for (const a of data.allocations) {
    const list = allocByRep.get(a.rep_id) ?? [];
    list.push(a);
    allocByRep.set(a.rep_id, list);
  }

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 4 }}>Allocation — {data.today}</h1>
      <p style={{ color: "#94a3b8", marginBottom: 24, fontSize: 13 }}>
        Pool inventory and per-rep allocations for today. Cron runs daily at 09:00 Beijing.
      </p>

      <section style={{ marginBottom: 24, padding: 16, border: "1px solid #1e293b", borderRadius: 8 }}>
        <h2 style={{ fontSize: 14, color: "#94a3b8", marginBottom: 12 }}>Pool inventory (unassigned leads)</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          {Object.entries(data.pool_inventory).map(([k, v]) => (
            <div key={k}>
              <div style={{ fontSize: 11, color: "#64748b" }}>{k}</div>
              <div style={{ fontSize: 24, fontWeight: 600 }}>{v}</div>
            </div>
          ))}
        </div>
      </section>

      <section style={{ marginBottom: 24, padding: 16, border: "1px solid #1e293b", borderRadius: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ fontSize: 14, color: "#94a3b8" }}>Today's allocations</h2>
          <button
            onClick={runNow}
            disabled={running}
            style={{
              padding: "6px 14px", fontSize: 13, fontWeight: 500,
              background: "#6366f1", color: "white",
              border: "none", borderRadius: 6, cursor: "pointer",
            }}
          >
            {running ? "Running…" : "Run allocator now"}
          </button>
        </div>
        <table style={{ width: "100%", fontSize: 13 }}>
          <thead>
            <tr style={{ color: "#64748b", textAlign: "left", fontSize: 11 }}>
              <th style={{ padding: 6 }}>Rep</th>
              <th style={{ padding: 6 }}>Target</th>
              <th style={{ padding: 6 }}>Got</th>
              <th style={{ padding: 6 }}>By pool</th>
              <th style={{ padding: 6 }}>Allocator</th>
              <th style={{ padding: 6 }}>Notified</th>
            </tr>
          </thead>
          <tbody>
            {data.reps.map((rep) => {
              const m = data.missions.find((x) => x.rep_id === rep.id);
              const allocs = allocByRep.get(rep.id) || [];
              const total = allocs.reduce((sum, a) => sum + (a.lead_ids?.length || 0), 0);
              const byPool = allocs.map((a) => `${a.pool_key}:${a.lead_ids?.length || 0}`).join(", ");
              const notif = allocs[0]?.notification_status ?? "—";
              const allocator = allocs[0]?.allocator ?? "—";
              return (
                <tr key={rep.id} style={{ borderTop: "1px solid #0f172a" }}>
                  <td style={{ padding: 6 }}>{rep.name}</td>
                  <td style={{ padding: 6, color: "#94a3b8" }}>{m?.target ?? "—"}</td>
                  <td style={{ padding: 6, fontWeight: 500 }}>{total || "—"}</td>
                  <td style={{ padding: 6, color: "#94a3b8", fontSize: 12 }}>{byPool || "—"}</td>
                  <td style={{ padding: 6, color: "#64748b", fontSize: 12 }}>{allocator}</td>
                  <td style={{ padding: 6, color: notif === "sent" ? "#10b981" : notif === "failed" ? "#f87171" : "#64748b" }}>
                    {notif}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Smoke test**

Visit `http://localhost:3000/admin/allocation` as admin. Confirm:
- Pool inventory shows non-zero counts (assuming there are unassigned leads from prior imports)
- Today's allocations table lists each rep
- "Run allocator now" button works (use shadow:true equivalent if you don't want to commit — easiest is to just leave non-shadow and clean up after)

- [ ] **Step 5: Commit**

```bash
git add src/app/api/admin/allocation/route.ts \
        src/app/api/admin/allocation/override/route.ts \
        src/app/admin/allocation/page.tsx
git commit -m "feat(pool): /admin/allocation cockpit + override API"
```

---

## Task 15: /missions empty-state messages

**Files:**
- Modify: `src/app/missions/page.tsx`

- [ ] **Step 1: Add empty-state branch**

Open `src/app/missions/page.tsx`. Find where it renders "My missions" (around lines 257–345 per the explore). Just before that section, add an empty-state branch when `my_today.length === 0`.

In the render, replace the section that currently shows "no missions" with:

```tsx
{(!data || (data.my_today || []).length === 0) && (
  <section style={{
    padding: 20, marginTop: 16, border: "1px solid #1e293b",
    borderRadius: 8, color: "#94a3b8", fontSize: 13,
  }}>
    {data?.team_focus?.status === "proposed" ? (
      <>
        本周的 missions 还在 admin 那里待批准. 你可以先 ping admin, 或者过 1-2 小时再看.
      </>
    ) : (
      <>
        今天还没有 missions. 系统每天早上 7 点 (Beijing) 自动生成, 9 点分配 leads.
        如果到 9:30 还是空的, ping admin 看看你的 daily quota 是不是没设.
      </>
    )}
  </section>
)}
```

(Adjust to match the file's existing styling conventions. Don't replace the team-focus banner or the team-visibility section — only add a message in the gap where the rep's checklist would normally be.)

- [ ] **Step 2: Smoke test**

Temporarily delete the test rep's missions for today, visit `/missions`, confirm the empty-state message renders. Restore.

- [ ] **Step 3: Commit**

```bash
git add src/app/missions/page.tsx
git commit -m "feat(missions): empty-state messages on /missions"
```

---

## Task 16: Onboarding walkthrough integration

**Files:**
- Modify: `src/lib/onboarding.ts`
- Modify: `src/lib/helper-read-tools.ts`

- [ ] **Step 1: Update Message 2**

Open `src/lib/onboarding.ts`. Find `msg2Lines` (around line 784–800). Replace the page-list section. The current 3 bullets become 4, with `/missions` first:

```typescript
const msg2Lines: string[] = [
  `**Dashboard**: https://calistamind.com`,
  `登录邮箱: \`${senderEmail}\``,
  `密码: 就是你刚才在这跟我设的那个.`,
  ``,
  `登进去之后看这几个页面就够了:`,
  `  • **/missions** — 今天该做什么. 每天早上 9 点系统给你分今天的 lead (我会在 Lark DM 你), 这页告诉你今天的目标和进度.`,
  `  • **/pipeline** — 你的 lead 在这. 系统按今天分配给你的 lead, AI 已经帮你拟好邮件草稿, 你看一眼 OK 就点 Send.`,
  `  • **/emails** — 邮件追踪. 谁打开了 / 谁回了 / 谁退订.`,
  `  • **/inbox** — 客户回信. (我会在收到新回复时主动 DM 你提醒.)`,
  ``,
  `**重要**: 我 (Leon) 不只在 Lark. 你登进 dashboard, 右下角有个 ✨ helper 按钮 — 那是同一个我, 上下文也是通的.`,
];
```

- [ ] **Step 2: Update Message 4**

Find `msg4Lines` (around line 847–887). Add a new example to "怎么使唤我":

```typescript
const msg4Lines: string[] = [
  `**怎么使唤我** (直接 DM 就行):`,
  `  • "今天的任务是什么?"  → 我会告诉你今天的目标 + 进度`,
  `  • "今天我还有几条 ready?"`,
  `  • "把张三的 lead 给 Leo"`,
  `  • "刚加了 wang@xxx 的微信"  → 我会自动标这条转化`,
  `  • "有新回复吗?"`,
  `  • "发了那条给张三的邮件"  → 我会真的把那封发出去`,
  ``,
  // ... rest unchanged
];
```

- [ ] **Step 3: Add helper tool `get_my_missions_today`**

Open `src/lib/helper-read-tools.ts`. Find the existing tool registration pattern (it's in the `READ_TOOL_NAMES` set near the top, with handlers in a switch-style block).

Add `get_my_missions_today` to `READ_TOOL_NAMES`:

```typescript
export const READ_TOOL_NAMES = new Set([
  // ... existing entries ...
  "get_my_missions_today",
]);
```

Find the tool dispatch (likely a `switch (tool)` or a Map). Add a handler:

```typescript
case "get_my_missions_today": {
  const { supabase } = await import("@/lib/db");
  const today = new Date().toISOString().slice(0, 10);
  // session.repId is available in this scope
  const ms = await supabase
    .from("missions")
    .select("id, kind, target, status, scope")
    .eq("rep_id", session.repId)
    .eq("due_date", today)
    .eq("status", "active");
  if (ms.error) return { ok: false, error: ms.error.message };
  // Pull progress
  const ids = (ms.data || []).map((m) => m.id);
  let progress: Map<string, number> = new Map();
  if (ids.length > 0) {
    const p = await supabase.from("mission_progress").select("mission_id, count").in("mission_id", ids);
    progress = new Map((p.data || []).map((r) => [r.mission_id, r.count]));
  }
  return {
    ok: true,
    missions: (ms.data || []).map((m) => ({
      id: m.id,
      kind: m.kind,
      target: m.target,
      progress: progress.get(m.id) ?? 0,
      scope: m.scope,
    })),
  };
}
```

Also add a one-line description in the `TOOLS_PROMPT` constant (find the `## 工具系统` text in `helper-tools.ts` or wherever it lives) so the LLM knows the tool exists:

```
- get_my_missions_today — 当前用户今天的 missions 列表. args: {}. 返回: { ok, missions: [{kind, target, progress}] }.
```

- [ ] **Step 4: Smoke test the bot tool**

In Lark, DM Leon: `"今天的任务是什么?"`. He should call `get_my_missions_today` and reply with your active missions and progress.

- [ ] **Step 5: Commit**

```bash
git add src/lib/onboarding.ts src/lib/helper-read-tools.ts
# also helper-tools.ts if TOOLS_PROMPT is there
git commit -m "feat(missions): onboarding walkthrough lists /missions + get_my_missions_today bot tool"
```

---

## Task 16.5: Onboarding — admin sets new rep's quota

**Files:**
- Modify: `src/lib/onboarding.ts`

**Context:** Under the new system, a rep with no quota row gets zero leads allocated. New reps approved through Lark onboarding hit `provisionRep()` which creates the `sales_reps` row but writes nothing to `rep_daily_quotas`. We need to (a) tell admin to set the quota right after approval and (b) tell the rep that their daily volume is collaboratively set.

- [ ] **Step 1: Add admin-side prompt at the end of approval flow**

In `src/lib/onboarding.ts`, find the function that runs when admin clicks "Approve" on a candidate (likely `handleAdminApproval` or similar — search for `provisionRep`). After the rep is provisioned and the 4 walkthrough DMs are sent to the rep, send an additional DM **to the admin** (not the rep):

```typescript
// After provisionRep() succeeds and walkthrough is queued for the rep:
const ADMIN_OPEN_ID_FOR_NOTIFICATION = adminOpenId; // the admin who just approved
const newRepName = pending.name ?? `rep_${newRepId}`;
const adminReminderLines = [
  `✅ ${newRepName} 已经接入了, walkthrough 我已经发了.`,
  ``,
  `**下一步: 设置他/她的 daily quota.**`,
  `去 https://calistamind.com/admin/missions, 在 Daily Quotas 表里给 ${newRepName} 填上每天的 per-pool 数字.`,
  `第一周建议偏少 (e.g. normal_cn: 4-6), 跟他/她聊一下感觉舒服的节奏再调.`,
  ``,
  `如果不设, 系统明早不会给 ${newRepName} 分 lead.`,
];
await sendMessage({
  receive_id: ADMIN_OPEN_ID_FOR_NOTIFICATION,
  receive_id_type: "open_id",
  text: adminReminderLines.join("\n"),
}).catch(() => null);
```

- [ ] **Step 2: Update Message 4 to set rep expectation**

In `msg4Lines` (updated in Task 16), add one line near the "第一周不用追求量" sentence, telling the rep that the daily volume is a conversation:

```typescript
msg4Lines.push(
  ``,
  `**你今天能拿多少 lead** — admin 在 dashboard 里给你设了一个每日 quota (per_pool 数字). 第一周一般偏少, 跟你聊一下感觉 OK 的节奏再调. 觉得多了或者少了, 直接跟 admin 说就行.`,
  ``,
  `第一封邮件慢慢看, 不急. 第一周不用追求量 — 把节奏感建立起来就行.`,
  // ... existing line about "明早 9 点 DM"
);
```

(Adapt the exact splice to where the existing "第一周不用追求量" line lives. The point is the rep learns the daily number isn't dropped on them — it's a conversation.)

- [ ] **Step 3: Add a 24h quota-missing follow-up DM to admin**

Add a new cron route `src/app/api/cron/onboarding-quota-check/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";

export const preferredRegion = ["hkg1"];

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") || "";
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Find reps approved in the last 7 days who still have no quota row OR a zero-sum quota.
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const reps = await supabase
    .from("sales_reps")
    .select("id, name, created_at, role, sender_email, active")
    .gte("created_at", since)
    .eq("active", true)
    .eq("role", "sales");

  const ADMIN_OPEN_ID = process.env.ADMIN_LARK_OPEN_ID;
  if (!ADMIN_OPEN_ID) return NextResponse.json({ checked: 0, dmd: 0, reason: "no_admin_open_id" });

  const { sendMessage } = await import("@/lib/lark");
  let dmd = 0;

  for (const rep of reps.data || []) {
    // Must be at least 24h since rep was created (so admin had time)
    const ageHours = (Date.now() - new Date(rep.created_at).getTime()) / 3_600_000;
    if (ageHours < 24) continue;

    const q = await supabase
      .from("rep_daily_quotas")
      .select("per_pool")
      .eq("rep_id", rep.id)
      .maybeSingle();

    const pp = (q.data?.per_pool ?? {}) as Record<string, number>;
    const total = (pp.strong ?? 0) + (pp.normal_cn ?? 0) + (pp.normal_overseas ?? 0) + (pp.normal_edu ?? 0);
    if (total > 0) continue;

    // Dedup: track that we sent this DM today
    const today = new Date().toISOString().slice(0, 10);
    const probe = await supabase
      .from("rep_daily_quotas_override")
      .select("id")
      .eq("rep_id", rep.id)
      .eq("due_date", today)
      .eq("reason", "_quota_check_dm_marker") // sentinel reason
      .maybeSingle();
    if (probe.data) continue;

    await sendMessage({
      receive_id: ADMIN_OPEN_ID,
      receive_id_type: "open_id",
      text:
        `⏰ ${rep.name} 已经接入 ${Math.floor(ageHours / 24)} 天了, 但 daily quota 还是 0. ` +
        `他/她今天还是收不到 lead. 去 /admin/missions 设一下, 或者跟他/她聊聊.`,
    }).catch(() => null);

    // Mark as DM'd today via a no-op override row (per_pool zeros, reason='_quota_check_dm_marker')
    await supabase.from("rep_daily_quotas_override").insert({
      rep_id: rep.id,
      due_date: today,
      per_pool: { strong: 0, normal_cn: 0, normal_overseas: 0, normal_edu: 0 },
      reason: "_quota_check_dm_marker",
    });
    dmd++;
  }

  return NextResponse.json({ checked: reps.data?.length || 0, dmd });
}
```

Note the dedup uses a sentinel row in `rep_daily_quotas_override` with `reason='_quota_check_dm_marker'`. The seeder in Task 9 needs to *ignore* override rows whose `reason` starts with `_quota_check_dm_marker` so this marker doesn't affect actual allocation. Add this guard in `getEffectiveQuota`:

```typescript
// In src/lib/quota-store.ts getEffectiveQuota, near the override lookup:
const ov = await supabase
  .from("rep_daily_quotas_override")
  .select("per_pool, reason")
  .eq("rep_id", repId)
  .eq("due_date", dueDate)
  .maybeSingle();
if (ov.data?.per_pool && !String(ov.data.reason || "").startsWith("_")) {
  return {
    rep_id: repId,
    per_pool: normalizePerPool(ov.data.per_pool),
    direction_priority: [],
    source: "override",
  };
}
```

- [ ] **Step 4: Wire the cron in vercel.json**

Add to `vercel.json` crons array:

```json
{ "path": "/api/cron/onboarding-quota-check", "schedule": "0 0 * * 1-5" }
```

(00:00 UTC = 08:00 Beijing, before allocation runs at 09:00.)

- [ ] **Step 5: Smoke test**

Create a test by inserting a fake new rep with `created_at = now() - interval '2 days'` and no quota. Trigger:

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  http://localhost:3000/api/cron/onboarding-quota-check | jq
```

Expected: `{checked: N, dmd: ≥1}`. Confirm admin received the reminder DM. Re-trigger same day → expected `dmd: 0` (already DM'd today). Clean up the test rep + sentinel rows.

- [ ] **Step 6: Commit**

```bash
git add src/lib/onboarding.ts src/lib/quota-store.ts \
        src/app/api/cron/onboarding-quota-check/route.ts vercel.json
git commit -m "feat(pool): admin onboarding prompts to set new rep's daily quota

After approving a new rep, bot DMs admin to set their daily quota at
/admin/missions and to have a 1:1 about what feels right for week 1.
Daily cron at 08:00 Beijing re-DMs admin if quota still zero after 24h.
Rep's walkthrough Message 4 now tells them the daily volume is a
conversation, not imposed."
```

---

## Task 17: Disable shadow mode (cron starts writing for real)

**Files:** Vercel env vars (no code change)

- [ ] **Step 1: Remove or set `ALLOCATE_LEADS_SHADOW` to "false"**

In the Vercel dashboard for this project: Settings → Environment Variables. Remove `ALLOCATE_LEADS_SHADOW` if present, or set it to `false` for the Production environment.

- [ ] **Step 2: Wait for the next 09:00 Beijing cron run, or trigger manually**

```bash
curl -s -X POST https://calistamind.com/api/missions/allocate-leads \
  -H "Cookie: AUTH_COOKIE=$ADMIN_COOKIE" \
  -H "Content-Type: application/json" \
  -d '{"shadow":false}' | jq
```

- [ ] **Step 3: Verify allocation happened end-to-end**

```sql
-- Allocation log rows for today should have notification_status set
SELECT rep_id, count(*) AS rows, notification_status
FROM allocation_log
WHERE due_date = CURRENT_DATE
GROUP BY rep_id, notification_status
ORDER BY rep_id;
```

Expected: each rep with a quota has at least one row, all with `notification_status='sent'` (or `'skipped_no_lark'` if a rep is missing `lark_open_id`).

```sql
-- Leads should now have assigned_rep_id set
SELECT assigned_rep_id, count(*)
FROM pipeline_leads
WHERE assigned_rep_id IS NOT NULL
  AND id IN (SELECT unnest(lead_ids) FROM allocation_log WHERE due_date = CURRENT_DATE)
GROUP BY assigned_rep_id;
```

Expected: counts match each rep's `mission.target` (within underfill tolerance).

No commit — this is operational configuration. Proceed to Task 18 (import-route flip) only after this verification passes.

---

## Task 18: Phase 2 flip — import route stops setting assigned_rep_id

**Files:**
- Modify: `src/app/api/pipeline/import/route.ts`

- [ ] **Step 1: Replace the assignRep call**

Open `src/app/api/pipeline/import/route.ts`. Around lines 241–254 (the `classifyLead` + `assignRep` block):

**Current:**
```typescript
const leadTier = classifyLead(config, {
  citationCount: pyCitation,
  hIndex: pyHIndex,
  schoolTier,
  authorEmail: email,
  localScore: pyLocalScore,
  industryOrgs,
});
const assignedRepId = assignRep(
  config,
  leadTier,
  email,
  (lead.matchedDirections as string) ?? null,
);
```

**Change to:**
```typescript
const leadTier = classifyLead(config, {
  citationCount: pyCitation,
  hIndex: pyHIndex,
  schoolTier,
  authorEmail: email,
  localScore: pyLocalScore,
  industryOrgs,
});
// Per docs/superpowers/specs/2026-05-13-shared-pool-and-mission-ux-design.md,
// assignment is deferred to /api/missions/allocate-leads (runs daily at 09:00
// Beijing). Imports land in the pool with assigned_rep_id=NULL; the allocator
// picks them up next morning based on each rep's daily quota.
const assignedRepId: number | null = null;
```

Around line 329 (the insert):
**Current:** `assigned_rep_id: assignedRepId,`
**Change to:** `assigned_rep_id: assignedRepId,` *(no change — `assignedRepId` is now `null`)*

Confirm `assignRep` import is no longer used — remove it from the import statement at the top of the file. The import is currently:

```typescript
import {
  getAssignmentConfig,
  classifyLead,
  assignRep,
  getRep,
} from "@/lib/assignment";
```

Change to:
```typescript
import {
  getAssignmentConfig,
  classifyLead,
  getRep,
} from "@/lib/assignment";
```

`getAssignmentConfig` and `classifyLead` are still needed (the latter sets `lead_tier`).

- [ ] **Step 2: Verify by importing a fresh test lead**

Wait for the Python scanner to import a real lead, OR manually POST to `/api/pipeline/import` with a test payload (use the existing test pattern from `scripts/test-*.mjs` if any exists, or curl with `Authorization: Bearer $PIPELINE_IMPORT_KEY`). Then:

```sql
SELECT id, author_email, lead_tier, assigned_rep_id, status, created_at
FROM pipeline_leads
WHERE created_at > now() - interval '5 minutes'
ORDER BY created_at DESC LIMIT 5;
```

Expected: `assigned_rep_id` is NULL for newly-inserted rows. `lead_tier` is still set.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/pipeline/import/route.ts
git commit -m "feat(pool): import route writes assigned_rep_id=NULL (Phase 2 flip)

Lead routing now happens at /api/missions/allocate-leads (09:00 Beijing daily)
based on admin-set quotas in rep_daily_quotas, not at import time.
Existing leads keep their assignments; only new imports defer."
```

---

---

## Task 19: Verification week + success-criteria sample

**Files:** none — observation only.

Run for 5 weekdays:

- [ ] **Day 1**: After 09:00 Beijing, screenshot `/admin/allocation` and confirm each rep's `Got` matches their `Target` (within underfill tolerance).
- [ ] **Day 1–5**: Ask each rep in Lark whether they received the morning DM. Note any "no DM" reports.
- [ ] **Day 3**: Sample 5 newly-imported leads from Day 2, verify they have `assigned_rep_id` set and were drawn by Day 3 (not stuck in pool >1 day).
- [ ] **Day 5**: Compare weekly send count to the prior week's baseline (`SELECT count(*) FROM emails WHERE created_at > now() - interval '7 days' AND created_at <= now()`). Should be within ±10%.
- [ ] **Day 5**: Pull 5 conversions from this week (`SELECT * FROM brief_lookups WHERE wechat_marked_at > now() - interval '7 days'`), verify `marked_by_rep_id` is correctly populated.
- [ ] **Day 7**: Ask Chenyu (or whoever is newest) about onboarding clarity. If they say missions are still confusing, file a follow-up.

If any success criterion fails, file an issue and consider Phase 3 rollback (revert the import route commit, run `/api/config/assignment` POST to retroactively re-assign).

---

## Open items deferred to follow-up plans

These are explicitly out of scope for this plan, called out so they aren't forgotten:

- **Reply-mission bumping.** `bumpMissionProgress` only fires for `kind='send'` and `kind='mark_wechat'`. A reply mission has no progress wiring yet.
- **Mid-day allocation re-balance.** If a rep finishes their batch by noon, no system tops them up. Admin can re-allocate via `/admin/allocation` manually.
- **Cherry-pick lane.** No rep-self-claim UI.
- **Direction-overrides-force-rep.** Today's 20 direction→Leo overrides are dropped; under new system, direction matters only as priority within strong pool. If a specific direction needs to force a specific rep, follow up.
