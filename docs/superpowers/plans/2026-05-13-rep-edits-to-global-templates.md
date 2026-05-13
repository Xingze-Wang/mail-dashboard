# Rep edits → global candidate templates — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task.

**Goal:** Wire the closed loop: per-rep edit clustering → per-rep `email_templates` row → two-signal gate (Wilson CI on actual clicks + avg `p_click` from ctr_regressor) → admin candidate queue → existing template promotion pipeline.

**Architecture:** Two new crons. One clusters each rep's last 30d of edits (embedding cosine ≥0.85, ≥5 members), writes the medoid as a per-rep `email_templates` row with `full_html_override`. The second compares each per-rep template against the global baseline on both actual clicks (Wilson CI non-overlap) and predicted clicks (avg `p_click` ≥1.1x lift). If both gates pass, writes `admin_inbox` row with `kind='candidate_global_template'`. Admin reviews on new `/admin/templates/candidates` page; approval clones the per-rep template content into a new global `status='proposal'` row that flows into the existing auto-promote loop.

**Tech Stack:** Same as parent project — Next.js 16, Supabase, `embedText()` from `src/lib/embeddings.ts`, existing `model_predictions` from migration 078. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-13-rep-edits-to-global-templates-design.md`
**Latest migration on disk:** 082. New migration: 083.

---

## File map

**New files:**
- `migrations/083-email-template-overrides.sql` + `scripts/apply-083.mjs`
- `src/lib/edit-clustering.ts` — pure helpers: `cosine()`, `clusterEdits()`, `pickMedoid()`
- `src/lib/template-candidate-gate.ts` — pure helpers: `wilsonInterval()`, `evaluateCandidate()`
- `src/app/api/cron/rep-edit-clustering/route.ts`
- `src/app/api/cron/candidate-global-promote/route.ts`
- `src/app/api/admin/templates/candidates/route.ts` — GET list + POST approve
- `src/app/admin/templates/candidates/page.tsx`
- `scripts/test-edit-clustering.mjs`
- `scripts/test-candidate-gate.mjs`

**Modified files:**
- `src/lib/template-assembler.ts` — honor `full_html_override`/`subject_override` when set
- `vercel.json` — add two cron entries
- `src/components/sidebar.tsx` — add `/admin/templates/candidates` link (admin-only)

---

## Task 1: Migration 083 — full_html_override on email_templates

**Files:**
- Create: `migrations/083-email-template-overrides.sql`
- Create: `scripts/apply-083.mjs`

- [ ] **Step 1: Write the migration**

```sql
-- migrations/083-email-template-overrides.sql
--
-- 1. SCHEMA CHANGE
-- Adds two nullable columns on email_templates:
--   full_html_override TEXT
--   subject_override TEXT
-- When set, template-assembler renders the entire body/subject from
-- these directly instead of stitching slots. Lets us materialize a
-- rep's full edited HTML as a template verbatim.
--
-- 2. WHO WRITES THIS?
-- /api/cron/rep-edit-clustering writes when it materializes a
-- per-rep template from a cluster of similar edits (Task 4 of this
-- plan). No other code writes these.
--
-- 3. WHO READS THIS?
-- src/lib/template-assembler.ts — assembleDraft(); if non-null, the
-- override is used and slot-based rendering is skipped for that field.
--
-- 4. BACKFILL FOR OLD ROWS
-- (c) intentionally NULL for legacy templates — they continue to
-- render via slot-based stitching. No backfill needed.

ALTER TABLE email_templates
  ADD COLUMN IF NOT EXISTS full_html_override TEXT,
  ADD COLUMN IF NOT EXISTS subject_override TEXT;
```

- [ ] **Step 2: Write the apply runner**

Match the pattern in `scripts/apply-082.mjs` (hardcoded Supabase URL + service key, see neighbor for the exact strings):

```javascript
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const sql = readFileSync("migrations/083-email-template-overrides.sql", "utf8");
const { error } = await sb.rpc("_exec_sql", { sql_text: sql });
if (error) { console.error("FAIL:", error.message); process.exit(1); }

const probe = await sb.from("email_templates").select("id, full_html_override, subject_override").limit(1);
if (probe.error) { console.error("Probe failed:", probe.error.message); process.exit(1); }
console.log("OK: full_html_override + subject_override columns exist");
```

- [ ] **Step 3: Run**

`node scripts/apply-083.mjs` → expect `OK: ...columns exist`.

- [ ] **Step 4: Commit**

```bash
git add migrations/083-email-template-overrides.sql scripts/apply-083.mjs
git commit -m "migration(083): email_templates full_html_override + subject_override

For rep-edit-derived templates that store the rep's full edit verbatim
without re-parsing into slot formats. Slot-based templates unaffected."
```

---

## Task 2: Edit clustering pure helpers

**Files:**
- Create: `src/lib/edit-clustering.ts`
- Create: `scripts/test-edit-clustering.mjs`

- [ ] **Step 1: Write the integration test (it will fail — module not yet exists)**

`scripts/test-edit-clustering.mjs`:

```javascript
/**
 * Integration test for src/lib/edit-clustering.ts.
 * Run: npx tsx --env-file=.env.local scripts/test-edit-clustering.mjs
 */

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) { console.log(`  ✓ ${msg}`); pass++; } else { console.error(`  ✗ ${msg}`); fail++; } };

console.log("Test 1: cosine of identical vectors is 1");
{
  const { cosine } = await import("../src/lib/edit-clustering.ts");
  const a = [1, 0, 0, 0];
  assert(Math.abs(cosine(a, a) - 1) < 1e-6, "cosine(a,a) ≈ 1");
}

console.log("\nTest 2: cosine of orthogonal vectors is 0");
{
  const { cosine } = await import("../src/lib/edit-clustering.ts");
  const a = [1, 0, 0, 0];
  const b = [0, 1, 0, 0];
  assert(Math.abs(cosine(a, b)) < 1e-6, "cosine(a,b) ≈ 0");
}

console.log("\nTest 3: clusterEdits groups similar embeddings");
{
  const { clusterEdits } = await import("../src/lib/edit-clustering.ts");
  // Two clusters: A and B
  const items = [
    { id: "a1", vec: [1, 0, 0, 0] },
    { id: "a2", vec: [0.95, 0.05, 0, 0] },
    { id: "a3", vec: [0.9, 0.1, 0, 0] },
    { id: "b1", vec: [0, 1, 0, 0] },
    { id: "b2", vec: [0, 0.95, 0.05, 0] },
  ];
  const clusters = clusterEdits(items, 0.85);
  assert(clusters.length === 2, `got ${clusters.length} clusters (expect 2)`);
  const sizes = clusters.map((c) => c.members.length).sort((x, y) => y - x);
  assert(sizes[0] === 3 && sizes[1] === 2, `cluster sizes ${sizes} (expect [3,2])`);
}

console.log("\nTest 4: pickMedoid returns the member closest to centroid");
{
  const { pickMedoid } = await import("../src/lib/edit-clustering.ts");
  const members = [
    { id: "x", vec: [1, 0] },
    { id: "y", vec: [0.99, 0.01] },
    { id: "z", vec: [0.7, 0.3] },
  ];
  const centroid = [0.95, 0.05];
  const med = pickMedoid(members, centroid);
  assert(med.id === "y", `medoid is y (got ${med.id})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
```

- [ ] **Step 2: Run, verify it fails**

`npx tsx --env-file=.env.local scripts/test-edit-clustering.mjs` → expect "Cannot find module".

- [ ] **Step 3: Implement `src/lib/edit-clustering.ts`**

```typescript
/**
 * Pure helpers for clustering rep edits by embedding similarity.
 * No DB access here — caller fetches data + embeddings, passes in arrays.
 */

export interface EditItem {
  id: string;        // lead_id
  vec: number[];     // embedding (1536-dim)
}

export interface Cluster {
  centroid: number[];
  members: EditItem[];
}

/** Cosine similarity of two equal-length vectors. */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error(`vector dim mismatch ${a.length} vs ${b.length}`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Mean of vectors (elementwise). */
function mean(vecs: number[][]): number[] {
  if (vecs.length === 0) return [];
  const dim = vecs[0].length;
  const out = new Array<number>(dim).fill(0);
  for (const v of vecs) {
    for (let i = 0; i < dim; i++) out[i] += v[i];
  }
  for (let i = 0; i < dim; i++) out[i] /= vecs.length;
  return out;
}

/**
 * Greedy single-linkage clustering by cosine similarity.
 * O(n²) — fine for n ≤ ~100 (per-rep monthly edits).
 *
 * @param items items to cluster (each has id + vec)
 * @param threshold minimum cosine to assign to existing cluster
 */
export function clusterEdits(items: EditItem[], threshold: number): Cluster[] {
  const clusters: Cluster[] = [];
  for (const item of items) {
    let best: { cluster: Cluster; sim: number } | null = null;
    for (const c of clusters) {
      const sim = cosine(item.vec, c.centroid);
      if (sim >= threshold && (!best || sim > best.sim)) {
        best = { cluster: c, sim };
      }
    }
    if (best) {
      best.cluster.members.push(item);
      best.cluster.centroid = mean(best.cluster.members.map((m) => m.vec));
    } else {
      clusters.push({ centroid: [...item.vec], members: [item] });
    }
  }
  return clusters;
}

/** The member whose vec is closest (highest cosine) to the centroid. */
export function pickMedoid(members: EditItem[], centroid: number[]): EditItem {
  if (members.length === 0) throw new Error("pickMedoid on empty cluster");
  let bestSim = -Infinity;
  let best = members[0];
  for (const m of members) {
    const s = cosine(m.vec, centroid);
    if (s > bestSim) {
      bestSim = s;
      best = m;
    }
  }
  return best;
}

/** Average pairwise cosine within a cluster — a tightness metric. */
export function clusterTightness(members: EditItem[]): number {
  if (members.length < 2) return 1;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      sum += cosine(members[i].vec, members[j].vec);
      n++;
    }
  }
  return n > 0 ? sum / n : 1;
}
```

- [ ] **Step 4: Run test, verify passes**

Expect 5 passing assertions.

- [ ] **Step 5: Commit**

```bash
git add src/lib/edit-clustering.ts scripts/test-edit-clustering.mjs
git commit -m "feat(templates): edit-clustering pure helpers + tests

cosine() / clusterEdits() / pickMedoid() / clusterTightness() — pure,
no DB. Greedy single-linkage by cosine, O(n²). Used by rep-edit-
clustering cron in subsequent task."
```

---

## Task 3: Candidate-gate pure helpers

**Files:**
- Create: `src/lib/template-candidate-gate.ts`
- Create: `scripts/test-candidate-gate.mjs`

- [ ] **Step 1: Write the test**

`scripts/test-candidate-gate.mjs`:

```javascript
let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) { console.log(`  ✓ ${msg}`); pass++; } else { console.error(`  ✗ ${msg}`); fail++; } };

console.log("Test 1: wilsonInterval — k=0 of n=30 yields lower bound 0");
{
  const { wilsonInterval } = await import("../src/lib/template-candidate-gate.ts");
  const ci = wilsonInterval(0, 30, 0.95);
  assert(Math.abs(ci.lower - 0) < 0.001, `lower ≈ 0 (got ${ci.lower})`);
  assert(ci.upper > 0 && ci.upper < 0.2, `upper between 0 and 0.2 (got ${ci.upper})`);
}

console.log("\nTest 2: wilsonInterval — k=15 of n=30 yields ~50% point estimate");
{
  const { wilsonInterval } = await import("../src/lib/template-candidate-gate.ts");
  const ci = wilsonInterval(15, 30, 0.95);
  assert(ci.lower > 0.3 && ci.lower < 0.5, `lower in (0.3, 0.5) (got ${ci.lower})`);
  assert(ci.upper > 0.5 && ci.upper < 0.7, `upper in (0.5, 0.7) (got ${ci.upper})`);
}

console.log("\nTest 3: evaluateCandidate — both signals strong → pass");
{
  const { evaluateCandidate } = await import("../src/lib/template-candidate-gate.ts");
  const res = evaluateCandidate({
    perRep: { clicked: 10, sent: 30 },        // 33% actual
    global:  { clicked: 5,  sent: 100 },       //  5% actual
    perRepPredicted: 0.30,
    globalPredicted: 0.10,
    predictedLiftRequired: 1.1,
  });
  assert(res.passes === true, "passes");
  assert(res.actualSignalAgrees === true, "actual signal agrees");
  assert(res.predictedSignalAgrees === true, "predicted signal agrees");
}

console.log("\nTest 4: evaluateCandidate — actual strong, predicted weak → fail");
{
  const { evaluateCandidate } = await import("../src/lib/template-candidate-gate.ts");
  const res = evaluateCandidate({
    perRep: { clicked: 10, sent: 30 },
    global:  { clicked: 5,  sent: 100 },
    perRepPredicted: 0.10,                     // not above global * 1.1
    globalPredicted: 0.10,
    predictedLiftRequired: 1.1,
  });
  assert(res.passes === false, "fails (predicted disagrees)");
  assert(res.predictedSignalAgrees === false, "predicted signal disagrees");
}

console.log("\nTest 5: evaluateCandidate — actual CIs overlap → fail");
{
  const { evaluateCandidate } = await import("../src/lib/template-candidate-gate.ts");
  const res = evaluateCandidate({
    perRep: { clicked: 11, sent: 100 },        // 11% with wide CI
    global:  { clicked: 9,  sent: 100 },        //  9% with overlapping CI
    perRepPredicted: 0.20,
    globalPredicted: 0.10,
    predictedLiftRequired: 1.1,
  });
  assert(res.passes === false, "fails (actual CIs overlap)");
  assert(res.actualSignalAgrees === false, "actual signal disagrees");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
```

- [ ] **Step 2: Run, verify it fails (module not found)**

- [ ] **Step 3: Implement `src/lib/template-candidate-gate.ts`**

```typescript
/**
 * Pure helpers for the two-signal gate that decides if a per-rep
 * template should be surfaced as a candidate global template.
 *
 * Signal 1: actual clicks (Wilson 95% CI non-overlap)
 * Signal 2: predicted clicks (avg p_click ≥ N% lift)
 *
 * No DB access. Caller fetches the numbers and passes them in.
 */

export interface CountPair {
  clicked: number;
  sent: number;
}

export interface WilsonCI {
  lower: number;
  upper: number;
  point: number;
}

/**
 * Wilson score interval for a Bernoulli proportion.
 * α=0.95 → z=1.96 by default.
 */
export function wilsonInterval(clicked: number, sent: number, alpha = 0.95): WilsonCI {
  if (sent <= 0) return { lower: 0, upper: 0, point: 0 };
  // z for 95% two-sided
  const z = alpha === 0.95 ? 1.96 : alpha === 0.99 ? 2.576 : 1.96;
  const n = sent;
  const p = clicked / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const halfWidth = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return {
    lower: Math.max(0, center - halfWidth),
    upper: Math.min(1, center + halfWidth),
    point: p,
  };
}

export interface EvaluateCandidateInput {
  perRep: CountPair;
  global: CountPair;
  perRepPredicted: number; // avg p_click from model_predictions
  globalPredicted: number;
  predictedLiftRequired: number; // e.g. 1.1 = 10% relative lift
  alpha?: number; // CI alpha, default 0.95
}

export interface EvaluateCandidateResult {
  passes: boolean;
  actualSignalAgrees: boolean;
  predictedSignalAgrees: boolean;
  perRepCI: WilsonCI;
  globalCI: WilsonCI;
  perRepPredicted: number;
  globalPredicted: number;
  predictedLift: number;
  reason: string;
}

export function evaluateCandidate(input: EvaluateCandidateInput): EvaluateCandidateResult {
  const alpha = input.alpha ?? 0.95;
  const perRepCI = wilsonInterval(input.perRep.clicked, input.perRep.sent, alpha);
  const globalCI = wilsonInterval(input.global.clicked, input.global.sent, alpha);

  // Actual: per-rep lower bound exceeds global upper bound (Wilson non-overlap)
  const actualSignalAgrees = perRepCI.lower > globalCI.upper;

  // Predicted: per-rep avg ≥ global avg × predictedLiftRequired
  const predictedLift =
    input.globalPredicted > 0 ? input.perRepPredicted / input.globalPredicted : Infinity;
  const predictedSignalAgrees = predictedLift >= input.predictedLiftRequired;

  const passes = actualSignalAgrees && predictedSignalAgrees;

  const reason = passes
    ? `Both signals agree. Actual CI ${perRepCI.lower.toFixed(3)} > ${globalCI.upper.toFixed(3)} (global UB). Predicted lift ${predictedLift.toFixed(2)}× ≥ ${input.predictedLiftRequired}×.`
    : `${actualSignalAgrees ? "Actual ✓" : `Actual ✗ (CIs overlap: per-rep [${perRepCI.lower.toFixed(3)}, ${perRepCI.upper.toFixed(3)}], global [${globalCI.lower.toFixed(3)}, ${globalCI.upper.toFixed(3)}])`}; ${predictedSignalAgrees ? "Predicted ✓" : `Predicted ✗ (lift ${predictedLift.toFixed(2)}× < ${input.predictedLiftRequired}×)`}`;

  return {
    passes,
    actualSignalAgrees,
    predictedSignalAgrees,
    perRepCI,
    globalCI,
    perRepPredicted: input.perRepPredicted,
    globalPredicted: input.globalPredicted,
    predictedLift,
    reason,
  };
}
```

- [ ] **Step 4: Run test, verify passes**

Expect 8 passing assertions.

- [ ] **Step 5: Commit**

```bash
git add src/lib/template-candidate-gate.ts scripts/test-candidate-gate.mjs
git commit -m "feat(templates): candidate-gate pure helpers + tests

Wilson 95% CI on actual clicks + predicted-lift comparison. Both
must agree for the gate to pass. Pure, no DB access."
```

---

## Task 4: Rep-edit-clustering cron

**Files:**
- Create: `src/app/api/cron/rep-edit-clustering/route.ts`

- [ ] **Step 1: Write the route**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { embedText } from "@/lib/embeddings";
import { clusterEdits, pickMedoid, clusterTightness, type EditItem } from "@/lib/edit-clustering";
import { requireSession } from "@/lib/auth-helpers";

export const preferredRegion = ["hkg1"];
export const maxDuration = 300;

const COSINE_THRESHOLD = 0.85;
const MIN_CLUSTER_SIZE = 5;
const MIN_EDIT_DISTANCE = 50; // skip typo-fixes
const LOOKBACK_DAYS = 30;

interface RunResult {
  ran_at: string;
  dry: boolean;
  per_rep: Array<{
    rep_id: number;
    rep_name: string;
    edits_pulled: number;
    clusters_found: number;
    clusters_qualifying: number;
    template_action?: "created" | "replaced" | "no_change" | "manual_template_in_place";
    new_template_id?: string;
    skipped_reason?: string;
  }>;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function run(dry: boolean): Promise<RunResult> {
  const result: RunResult = { ran_at: new Date().toISOString(), dry, per_rep: [] };
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();

  // Sales-role reps only (admins/seniors handled separately if at all)
  const reps = await supabase
    .from("sales_reps")
    .select("id, name")
    .eq("active", true)
    .eq("role", "sales");
  if (reps.error || !reps.data) {
    throw new Error(`reps query failed: ${reps.error?.message ?? "no data"}`);
  }

  for (const rep of reps.data) {
    const entry: RunResult["per_rep"][number] = {
      rep_id: rep.id,
      rep_name: rep.name as string,
      edits_pulled: 0,
      clusters_found: 0,
      clusters_qualifying: 0,
    };

    // Pull edits this rep made in the lookback window
    const edits = await supabase
      .from("pipeline_leads")
      .select("id, draft_original_html, draft_html, draft_original_subject, draft_subject, draft_edit_distance, sent_at")
      .eq("assigned_rep_id", rep.id)
      .eq("status", "sent")
      .gte("sent_at", since)
      .not("draft_original_html", "is", null)
      .not("draft_html", "is", null)
      .gt("draft_edit_distance", MIN_EDIT_DISTANCE)
      .limit(200);
    if (edits.error || !edits.data || edits.data.length < MIN_CLUSTER_SIZE) {
      entry.skipped_reason = `only ${edits.data?.length ?? 0} qualifying edits (need ${MIN_CLUSTER_SIZE})`;
      result.per_rep.push(entry);
      continue;
    }
    entry.edits_pulled = edits.data.length;

    // Embed each edited HTML (stripped to plain text)
    const items: EditItem[] = [];
    for (const e of edits.data) {
      const text = stripHtml((e.draft_html as string) ?? "").slice(0, 2000);
      if (text.length < 50) continue;
      try {
        const vec = await embedText(text);
        items.push({ id: e.id as string, vec });
      } catch (err) {
        console.error(`[rep-edit-clustering] embedding failed for lead ${e.id}:`, err);
      }
    }

    const clusters = clusterEdits(items, COSINE_THRESHOLD);
    entry.clusters_found = clusters.length;

    const qualifying = clusters.filter((c) => c.members.length >= MIN_CLUSTER_SIZE);
    entry.clusters_qualifying = qualifying.length;
    if (qualifying.length === 0) {
      entry.skipped_reason = "no cluster reached min size";
      result.per_rep.push(entry);
      continue;
    }

    // Take the largest cluster (max members)
    qualifying.sort((a, b) => b.members.length - a.members.length);
    const winner = qualifying[0];
    const medoid = pickMedoid(winner.members, winner.centroid);
    const medoidLead = edits.data.find((e) => e.id === medoid.id);
    if (!medoidLead) {
      entry.skipped_reason = "medoid lead not found in fetched edits";
      result.per_rep.push(entry);
      continue;
    }

    // Check existing active per-rep template
    const existing = await supabase
      .from("email_templates")
      .select("id, proposed_by, full_html_override, name")
      .eq("rep_id", rep.id)
      .eq("active", true)
      .maybeSingle();

    if (existing.data && existing.data.proposed_by !== "rep_edit_cluster") {
      entry.template_action = "manual_template_in_place";
      result.per_rep.push(entry);
      continue;
    }

    // Determine if action is needed
    const newHtml = (medoidLead.draft_html as string) ?? "";
    const newSubject = (medoidLead.draft_subject as string) ?? null;

    if (existing.data && existing.data.full_html_override === newHtml) {
      entry.template_action = "no_change";
      result.per_rep.push(entry);
      continue;
    }

    const sampleIds = winner.members.slice(0, 10).map((m) => m.id);
    const evidence = {
      cluster_size: winner.members.length,
      sample_lead_ids: sampleIds,
      centroid_tightness: clusterTightness(winner.members),
      medoid_lead_id: medoid.id,
      detection_run_at: result.ran_at,
      dedup_key: `rep-edit-cluster-${rep.id}-${medoid.id}`,
    };

    if (dry) {
      entry.template_action = existing.data ? "replaced" : "created";
      result.per_rep.push(entry);
      continue;
    }

    // Archive old auto-derived template if present
    if (existing.data) {
      await supabase
        .from("email_templates")
        .update({ active: false, status: "archived" })
        .eq("id", existing.data.id);
    }

    // Insert new per-rep template
    const ins = await supabase
      .from("email_templates")
      .insert({
        name: `${rep.name}'s edit pattern (${winner.members.length} edits)`,
        rep_id: rep.id,
        active: true,
        status: "active",
        proposed_by: "rep_edit_cluster",
        proposed_reason: `Auto-detected from ${winner.members.length} similar edits by ${rep.name} in the last ${LOOKBACK_DAYS} days. Tightness ${evidence.centroid_tightness.toFixed(3)}.`,
        proposed_evidence: evidence,
        full_html_override: newHtml,
        subject_override: newSubject,
        // Slot fields remain null — template-assembler uses overrides when present
      })
      .select("id")
      .maybeSingle();
    if (ins.error) {
      entry.skipped_reason = `insert failed: ${ins.error.message}`;
    } else {
      entry.template_action = existing.data ? "replaced" : "created";
      entry.new_template_id = ins.data?.id as string;
    }
    result.per_rep.push(entry);
  }

  return result;
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") || "";
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const result = await run(dry);
  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  const session = await requireSession(req);
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "admin only" }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  const dry = body.dry === true;
  const result = await run(dry);
  return NextResponse.json(result);
}
```

- [ ] **Step 2: tsc check**

`npx tsc --noEmit` — must pass.

- [ ] **Step 3: Smoke test in dry mode (optional but recommended)**

Make a request via curl with the proper bearer and `?dry=1`. Confirm the response shape; no DB writes.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/cron/rep-edit-clustering/route.ts
git commit -m "feat(templates): rep-edit-clustering cron route

GET (bearer auth) and POST (admin) entry points. For each sales rep,
pulls last 30d of edits with distance > 50, embeds each, clusters by
cosine ≥0.85, materializes the largest qualifying cluster (≥5 members)
as a per-rep email_templates row with full_html_override set to the
medoid edit. Skips reps with a manually-created per-rep template.
Supports ?dry=1 for non-destructive runs."
```

---

## Task 5: Template assembler honors overrides

**Files:**
- Modify: `src/lib/template-assembler.ts`

- [ ] **Step 1: Find the right place to inject override**

Read `src/lib/template-assembler.ts` and find `assembleDraft()` (the main entry point). It currently renders subject from `subject_format` + body from slot stitching.

- [ ] **Step 2: Add the override branch**

At the top of the body-rendering block (and the subject block), check if the loaded template has `full_html_override` / `subject_override` set. If yes, use them directly (after running `fillRepPlaceholders` over them so `{{REP_NAME}}` etc. resolve).

The exact edit depends on the file structure. The pattern is roughly:

```typescript
// In assembleDraft, after loading the template:
const template = await loadEffectiveTemplate({ rep_id, lead_id });

// Subject
let subject: string;
if (template.subject_override) {
  subject = template.subject_override;
} else {
  subject = renderSubjectFromSlots(template, lead, rep);
}

// Body
let html: string;
if (template.full_html_override) {
  html = template.full_html_override;
} else {
  html = renderBodyFromSlots(template, lead, rep);
}

// Then apply placeholder substitution (REP_NAME, REP_WECHAT, etc.) to both.
({ subject, html } = fillRepPlaceholders({ subject, html }, rep));
```

If `loadEffectiveTemplate` returns a row without these new columns (because the type is stale), update the type and add the SELECT field.

Also update the database read at `template-assembler.ts` that fetches the template — make sure the SELECT includes `full_html_override, subject_override`.

- [ ] **Step 3: tsc check**

`npx tsc --noEmit` — must pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/template-assembler.ts
git commit -m "feat(templates): template-assembler honors full_html_override + subject_override

When a per-rep template has full_html_override set (typically from
rep-edit-clustering), use it directly instead of stitching slots.
Placeholders ({{REP_NAME}}, {{REP_WECHAT}}, etc.) are still resolved
on top of the override. Slot-based templates are unaffected."
```

---

## Task 6: Candidate-global-promote cron

**Files:**
- Create: `src/app/api/cron/candidate-global-promote/route.ts`

- [ ] **Step 1: Write the route**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { evaluateCandidate } from "@/lib/template-candidate-gate";
import { requireSession } from "@/lib/auth-helpers";

export const preferredRegion = ["hkg1"];
export const maxDuration = 300;

const MIN_SAMPLE = 30;
const MIN_PREDICTIONS = 20;
const LOOKBACK_DAYS = 30;
const PREDICTED_LIFT_REQUIRED = 1.1;

interface PerTemplateResult {
  template_id: string;
  rep_id: number;
  template_name: string;
  sample_size: number;
  predictions_count: number;
  passes?: boolean;
  reason?: string;
  skipped_reason?: string;
  inbox_action?: "created" | "updated" | "no_change" | "dismissed_by_system";
}

interface RunResult {
  ran_at: string;
  dry: boolean;
  per_template: PerTemplateResult[];
}

async function run(dry: boolean): Promise<RunResult> {
  const result: RunResult = { ran_at: new Date().toISOString(), dry, per_template: [] };
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();

  // Per-rep active templates (rep_id IS NOT NULL)
  const perRepTemplates = await supabase
    .from("email_templates")
    .select("id, rep_id, name, proposed_by")
    .eq("active", true)
    .not("rep_id", "is", null);
  if (perRepTemplates.error) {
    throw new Error(`per-rep templates query failed: ${perRepTemplates.error.message}`);
  }

  // The current global active template (rep_id IS NULL, active=true).
  // For v1 we use a single global baseline. If multiple globals exist
  // by segment, future enhancement matches per-segment.
  const globalT = await supabase
    .from("email_templates")
    .select("id, name")
    .is("rep_id", null)
    .eq("active", true)
    .maybeSingle();
  if (!globalT.data) {
    return result; // no global to compare to
  }

  // Pull the active ctr_regressor prompt id (for fetching predictions)
  const ctrPrompt = await supabase
    .from("model_prompts")
    .select("id")
    .eq("kind", "ctr_regressor")
    .eq("active", true)
    .maybeSingle();
  const ctrPromptId = ctrPrompt.data?.id ?? null;

  // Pre-compute global baseline once (actual + predicted)
  const globalEmails = await supabase
    .from("emails")
    .select("id, status, created_at")
    .eq("template_id", globalT.data.id)
    .gte("created_at", since)
    .limit(2000);
  if (globalEmails.error) {
    throw new Error(`global emails query failed: ${globalEmails.error.message}`);
  }
  const globalSent = globalEmails.data?.length ?? 0;
  const globalEmailIds = (globalEmails.data ?? []).map((e) => e.id as string);
  const globalClicked = await countClicks(globalEmailIds);
  const globalPredicted = ctrPromptId
    ? await avgPredictedPClick(globalEmailIds, ctrPromptId)
    : 0;

  for (const tpl of perRepTemplates.data ?? []) {
    const entry: PerTemplateResult = {
      template_id: tpl.id as string,
      rep_id: tpl.rep_id as number,
      template_name: tpl.name as string,
      sample_size: 0,
      predictions_count: 0,
    };

    const perRepEmails = await supabase
      .from("emails")
      .select("id, created_at")
      .eq("template_id", tpl.id)
      .gte("created_at", since)
      .limit(2000);
    if (perRepEmails.error) {
      entry.skipped_reason = `query failed: ${perRepEmails.error.message}`;
      result.per_template.push(entry);
      continue;
    }
    const perRepSent = perRepEmails.data?.length ?? 0;
    entry.sample_size = perRepSent;
    if (perRepSent < MIN_SAMPLE) {
      entry.skipped_reason = `sample size ${perRepSent} < ${MIN_SAMPLE}`;
      result.per_template.push(entry);
      continue;
    }

    const perRepEmailIds = perRepEmails.data!.map((e) => e.id as string);
    const perRepClicked = await countClicks(perRepEmailIds);
    let perRepPredicted = 0;
    let perRepPredictionCount = 0;
    if (ctrPromptId) {
      const r = await predictionStats(perRepEmailIds, ctrPromptId);
      perRepPredicted = r.avg;
      perRepPredictionCount = r.count;
    }
    entry.predictions_count = perRepPredictionCount;
    if (perRepPredictionCount < MIN_PREDICTIONS) {
      entry.skipped_reason = `predictions ${perRepPredictionCount} < ${MIN_PREDICTIONS}`;
      result.per_template.push(entry);
      continue;
    }

    const gate = evaluateCandidate({
      perRep: { clicked: perRepClicked, sent: perRepSent },
      global: { clicked: globalClicked, sent: globalSent },
      perRepPredicted,
      globalPredicted,
      predictedLiftRequired: PREDICTED_LIFT_REQUIRED,
    });
    entry.passes = gate.passes;
    entry.reason = gate.reason;

    const dedupHash = `candidate-global-${tpl.id}`;
    const evidence = {
      rep_id: tpl.rep_id,
      per_rep_template_id: tpl.id,
      global_template_id: globalT.data.id,
      sample_size: perRepSent,
      actual_per_rep: {
        clicked: perRepClicked,
        sent: perRepSent,
        rate: perRepClicked / perRepSent,
        wilson_lower: gate.perRepCI.lower,
        wilson_upper: gate.perRepCI.upper,
      },
      actual_global: {
        clicked: globalClicked,
        sent: globalSent,
        rate: globalSent > 0 ? globalClicked / globalSent : 0,
        wilson_lower: gate.globalCI.lower,
        wilson_upper: gate.globalCI.upper,
      },
      predicted_per_rep: perRepPredicted,
      predicted_global: globalPredicted,
      predicted_lift: gate.predictedLift,
      decision_run_at: result.ran_at,
      proposed_by_source: tpl.proposed_by,
    };

    if (gate.passes) {
      if (dry) {
        entry.inbox_action = "created";
      } else {
        const upsert = await supabase
          .from("admin_inbox")
          .upsert(
            {
              kind: "candidate_global_template",
              headline: `Per-rep template "${tpl.name}" beats global on both signals`,
              body:
                `Sample: ${perRepSent} sends from rep #${tpl.rep_id} vs ${globalSent} on global.\n\n` +
                `${gate.reason}\n\n` +
                `Review at /admin/templates/candidates`,
              evidence,
              status: "pending",
              dedup_hash: dedupHash,
            },
            { onConflict: "dedup_hash" },
          );
        entry.inbox_action = upsert.error ? "no_change" : "updated";
      }
    } else {
      // If we previously surfaced this and admin hasn't acted, dismiss it
      const prior = await supabase
        .from("admin_inbox")
        .select("id, status")
        .eq("dedup_hash", dedupHash)
        .maybeSingle();
      if (prior.data && prior.data.status === "pending") {
        if (!dry) {
          await supabase
            .from("admin_inbox")
            .update({ status: "dismissed_by_system", body: `Evidence changed: ${gate.reason}` })
            .eq("id", prior.data.id);
        }
        entry.inbox_action = "dismissed_by_system";
      } else {
        entry.inbox_action = "no_change";
      }
    }

    result.per_template.push(entry);
  }

  return result;
}

async function countClicks(emailIds: string[]): Promise<number> {
  if (emailIds.length === 0) return 0;
  // Click signal: webhook_events with type='email.clicked' for these emails
  // The canonical history per CLAUDE.md is webhook_events, not emails.status.
  const r = await supabase
    .from("webhook_events")
    .select("email_id", { count: "exact", head: true })
    .eq("type", "email.clicked")
    .in("email_id", emailIds);
  if (r.error) {
    console.error(`[candidate-global-promote] countClicks failed: ${r.error.message}`);
    return 0;
  }
  return r.count ?? 0;
}

async function avgPredictedPClick(emailIds: string[], promptId: string): Promise<number> {
  const r = await predictionStats(emailIds, promptId);
  return r.avg;
}

async function predictionStats(emailIds: string[], promptId: string): Promise<{ avg: number; count: number }> {
  if (emailIds.length === 0) return { avg: 0, count: 0 };
  const r = await supabase
    .from("model_predictions")
    .select("headline")
    .eq("prompt_id", promptId)
    .in("target_id", emailIds);
  if (r.error || !r.data || r.data.length === 0) return { avg: 0, count: 0 };
  let sum = 0;
  let n = 0;
  for (const row of r.data) {
    const v = Number(row.headline);
    if (Number.isFinite(v)) {
      sum += v;
      n++;
    }
  }
  return { avg: n > 0 ? sum / n : 0, count: n };
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") || "";
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const result = await run(dry);
  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  const session = await requireSession(req);
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "admin only" }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  const dry = body.dry === true;
  const result = await run(dry);
  return NextResponse.json(result);
}
```

- [ ] **Step 2: tsc check**

`npx tsc --noEmit` — must pass.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/cron/candidate-global-promote/route.ts
git commit -m "feat(templates): candidate-global-promote cron route

GET (bearer) + POST (admin) entry points. For each per-rep template,
compares actual clicks (Wilson 95% CI) AND predicted clicks (avg
p_click from active ctr_regressor prompt) against the global baseline.
If both signals agree (Wilson non-overlap + ≥1.1× predicted lift),
upserts admin_inbox row with kind='candidate_global_template'.
Dedup via dedup_hash. Re-runs are idempotent. ?dry=1 supported."
```

---

## Task 7: Wire crons in vercel.json

**Files:**
- Modify: `vercel.json`

- [ ] **Step 1: Add cron entries**

Insert near the other template-related crons:

```json
{ "path": "/api/cron/rep-edit-clustering",        "schedule": "0 18 * * 0" },
{ "path": "/api/cron/candidate-global-promote",   "schedule": "0 19 * * 0" },
```

Schedule: Sun 18:00 UTC = Mon 02:00 Beijing for clustering; Sun 19:00 UTC = Mon 03:00 Beijing for the gate. Runs after the existing drift-mining cron, before the work week starts.

- [ ] **Step 2: Commit**

```bash
git add vercel.json
git commit -m "feat(templates): schedule rep-edit-clustering + candidate-global-promote crons

Sun 18:00 UTC (Mon 02:00 Beijing) — clustering runs
Sun 19:00 UTC (Mon 03:00 Beijing) — gate runs

One hour gap lets clustering's writes settle before the gate reads them.
Both run weekly because cluster signals don't change minute-to-minute and
weekly admin-review cadence matches."
```

---

## Task 8: Admin candidate-queue API + page

**Files:**
- Create: `src/app/api/admin/templates/candidates/route.ts`
- Create: `src/app/admin/templates/candidates/page.tsx`

- [ ] **Step 1: API route**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { supabase } from "@/lib/db";

export const dynamic = "force-dynamic";

/** GET: list pending + recent decided candidate inbox rows. */
export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "admin only" }, { status: 403 });
  }

  // Pending candidates
  const pending = await supabase
    .from("admin_inbox")
    .select("id, kind, headline, body, evidence, status, created_at")
    .eq("kind", "candidate_global_template")
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  // Recent decided (last 30d)
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const decided = await supabase
    .from("admin_inbox")
    .select("id, kind, headline, status, created_at")
    .eq("kind", "candidate_global_template")
    .neq("status", "pending")
    .gte("created_at", since)
    .order("created_at", { ascending: false });

  return NextResponse.json({
    pending: pending.data || [],
    decided: decided.data || [],
  });
}

/** POST: approve OR reject a candidate.
 *  Body: { inbox_id, action: 'approve' | 'reject' }
 *  approve → clone per-rep template into a new global proposal row
 *  reject  → mark inbox status='dismissed'
 */
export async function POST(req: NextRequest) {
  const session = await requireSession(req);
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "admin only" }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  const inboxId = body.inbox_id as string;
  const action = body.action as "approve" | "reject";
  if (!inboxId || !["approve", "reject"].includes(action)) {
    return NextResponse.json({ error: "inbox_id + action required" }, { status: 400 });
  }

  const row = await supabase
    .from("admin_inbox")
    .select("id, evidence, status")
    .eq("id", inboxId)
    .maybeSingle();
  if (!row.data) {
    return NextResponse.json({ error: "inbox row not found" }, { status: 404 });
  }
  if (row.data.status !== "pending") {
    return NextResponse.json({ error: "already decided" }, { status: 409 });
  }

  const evidence = row.data.evidence as {
    per_rep_template_id?: string;
  } | null;

  if (action === "reject") {
    await supabase
      .from("admin_inbox")
      .update({ status: "dismissed", decided_by_rep_id: session.repId })
      .eq("id", inboxId);
    return NextResponse.json({ ok: true, action: "rejected" });
  }

  // approve: clone the per-rep template into a new global proposal
  if (!evidence?.per_rep_template_id) {
    return NextResponse.json({ error: "evidence missing per_rep_template_id" }, { status: 400 });
  }
  const src = await supabase
    .from("email_templates")
    .select("*")
    .eq("id", evidence.per_rep_template_id)
    .maybeSingle();
  if (!src.data) {
    return NextResponse.json({ error: "source per-rep template not found" }, { status: 404 });
  }

  const clone = {
    name: `${src.data.name} (proposed global)`,
    rep_id: null,
    active: false,
    status: "proposal",
    proposed_by: "admin_from_rep_edit",
    proposed_reason: `Promoted by admin from per-rep template ${src.data.id}. Original evidence: ${JSON.stringify(src.data.proposed_evidence)}`,
    proposed_evidence: { ...(src.data.proposed_evidence as Record<string, unknown>), promoted_from: src.data.id, promoted_by: session.repId, promoted_at: new Date().toISOString() },
    subject_format: src.data.subject_format,
    intro_prompt: src.data.intro_prompt,
    greeting_format: src.data.greeting_format,
    rep_intro_format: src.data.rep_intro_format,
    school_pitch_format: src.data.school_pitch_format,
    cta_signoff_format: src.data.cta_signoff_format,
    notes: src.data.notes,
    full_html_override: src.data.full_html_override,
    subject_override: src.data.subject_override,
  };

  const ins = await supabase.from("email_templates").insert(clone).select("id").maybeSingle();
  if (ins.error) {
    return NextResponse.json({ error: ins.error.message }, { status: 500 });
  }

  await supabase
    .from("admin_inbox")
    .update({ status: "approved", decided_by_rep_id: session.repId })
    .eq("id", inboxId);

  return NextResponse.json({
    ok: true,
    action: "approved",
    new_proposal_template_id: ins.data?.id,
  });
}
```

- [ ] **Step 2: Admin page**

```tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import { Loader2, Check, X, ArrowRight } from "lucide-react";

interface CandidateRow {
  id: string;
  headline: string;
  body: string;
  status: string;
  created_at: string;
  evidence: {
    rep_id?: number;
    per_rep_template_id?: string;
    global_template_id?: string;
    sample_size?: number;
    actual_per_rep?: { clicked: number; sent: number; rate: number; wilson_lower: number; wilson_upper: number };
    actual_global?:  { clicked: number; sent: number; rate: number; wilson_lower: number; wilson_upper: number };
    predicted_per_rep?: number;
    predicted_global?: number;
    predicted_lift?: number;
  };
}

interface PageData {
  pending: CandidateRow[];
  decided: Array<{ id: string; headline: string; status: string; created_at: string }>;
}

export default function CandidatesPage() {
  const [data, setData] = useState<PageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch("/api/admin/templates/candidates", { credentials: "include", cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData(await r.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const decide = async (id: string, action: "approve" | "reject") => {
    setActing(id);
    try {
      const r = await fetch("/api/admin/templates/candidates", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inbox_id: id, action }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setActing(null); }
  };

  if (loading) return <div style={{ padding: 24 }}><Loader2 size={14} className="animate-spin" /> Loading…</div>;
  if (error) return <div style={{ padding: 24, color: "#f87171" }}>Error: {error}</div>;
  if (!data) return null;

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 4 }}>Template candidates</h1>
      <p style={{ color: "#94a3b8", marginBottom: 24, fontSize: 13 }}>
        Per-rep templates that beat the current global on both actual clicks (Wilson CI) and predicted clicks (ctr_regressor).
        Approve to clone into a new global proposal; the existing template-auto-promote pipeline takes it from there.
      </p>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 14, color: "#94a3b8", marginBottom: 12 }}>Pending ({data.pending.length})</h2>
        {data.pending.length === 0 ? (
          <p style={{ color: "#64748b", fontSize: 13 }}>No candidates pending. Comes from /api/cron/candidate-global-promote (Mon 03:00 Beijing weekly).</p>
        ) : (
          data.pending.map((c) => {
            const a = c.evidence.actual_per_rep;
            const ag = c.evidence.actual_global;
            const liftActual = a && ag ? (a.rate - ag.rate) / Math.max(ag.rate, 1e-6) : null;
            const liftPredicted = c.evidence.predicted_lift ?? null;
            return (
              <div key={c.id} style={{
                marginBottom: 16, padding: 16,
                border: "1px solid #1e293b", borderRadius: 8,
              }}>
                <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>{c.headline}</div>
                <pre style={{ fontSize: 12, color: "#94a3b8", whiteSpace: "pre-wrap", marginBottom: 12 }}>{c.body}</pre>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 12 }}>
                  <div>
                    <div style={{ fontSize: 11, color: "#64748b" }}>Actual CTR (Wilson 95% CI)</div>
                    <div style={{ fontSize: 14 }}>
                      Per-rep: {a ? `${(a.rate * 100).toFixed(1)}% [${(a.wilson_lower * 100).toFixed(1)}, ${(a.wilson_upper * 100).toFixed(1)}]` : "—"}
                    </div>
                    <div style={{ fontSize: 14 }}>
                      Global:  {ag ? `${(ag.rate * 100).toFixed(1)}% [${(ag.wilson_lower * 100).toFixed(1)}, ${(ag.wilson_upper * 100).toFixed(1)}]` : "—"}
                    </div>
                    {liftActual !== null && (
                      <div style={{ fontSize: 12, color: liftActual > 0 ? "#10b981" : "#f87171" }}>
                        relative lift {(liftActual * 100).toFixed(0)}%
                      </div>
                    )}
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: "#64748b" }}>Predicted p_click (avg)</div>
                    <div style={{ fontSize: 14 }}>Per-rep: {(c.evidence.predicted_per_rep ?? 0).toFixed(3)}</div>
                    <div style={{ fontSize: 14 }}>Global:  {(c.evidence.predicted_global ?? 0).toFixed(3)}</div>
                    {liftPredicted !== null && (
                      <div style={{ fontSize: 12, color: liftPredicted > 1 ? "#10b981" : "#f87171" }}>
                        ratio {liftPredicted.toFixed(2)}×
                      </div>
                    )}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={() => void decide(c.id, "approve")}
                    disabled={acting === c.id}
                    style={{
                      padding: "6px 14px", fontSize: 13, fontWeight: 500,
                      background: "#10b981", color: "white",
                      border: "none", borderRadius: 6, cursor: "pointer",
                      display: "flex", alignItems: "center", gap: 6,
                    }}
                  >
                    <Check size={14} /> Promote to global proposal <ArrowRight size={14} />
                  </button>
                  <button
                    onClick={() => void decide(c.id, "reject")}
                    disabled={acting === c.id}
                    style={{
                      padding: "6px 14px", fontSize: 13,
                      background: "transparent", color: "#94a3b8",
                      border: "1px solid #1e293b", borderRadius: 6, cursor: "pointer",
                      display: "flex", alignItems: "center", gap: 6,
                    }}
                  >
                    <X size={14} /> Reject — keep per-rep only
                  </button>
                </div>
              </div>
            );
          })
        )}
      </section>

      <section>
        <h2 style={{ fontSize: 14, color: "#94a3b8", marginBottom: 12 }}>Recent decisions ({data.decided.length})</h2>
        {data.decided.length === 0 ? (
          <p style={{ color: "#64748b", fontSize: 13 }}>None.</p>
        ) : (
          <ul style={{ fontSize: 12, color: "#94a3b8", listStyle: "none", padding: 0 }}>
            {data.decided.map((d) => (
              <li key={d.id} style={{ padding: "6px 0", borderBottom: "1px solid #0f172a" }}>
                <span style={{ color: d.status === "approved" ? "#10b981" : "#64748b", textTransform: "uppercase", fontSize: 10 }}>{d.status}</span>{" — "}
                {d.headline}{" "}
                <span style={{ color: "#475569" }}>· {new Date(d.created_at).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 3: tsc check**

`npx tsc --noEmit` — must pass.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/admin/templates/candidates/route.ts src/app/admin/templates/candidates/page.tsx
git commit -m "feat(templates): admin candidate-queue page + API

GET lists pending+decided candidate_global_template inbox rows.
POST handles approve (clone per-rep template into new global proposal,
mark inbox approved) and reject (mark inbox dismissed).
Page shows side-by-side actual + predicted metrics with two action buttons."
```

---

## Task 9: Sidebar link to candidates page

**Files:**
- Modify: `src/components/sidebar.tsx`
- Modify: `src/lib/i18n.ts`

- [ ] **Step 1: Add nav entry + i18n**

Add to `toolsNav` in `src/components/sidebar.tsx` (after `/admin/missions` and `/admin/allocation`):

```typescript
{ href: "/admin/templates/candidates", label: t("nav.adminTemplateCandidates", locale), Icon: AdminTemplateCandidatesIcon, adminOnly: true },
```

Add a small SVG icon `AdminTemplateCandidatesIcon` near the others (a "star" or "rocket" — match the inline-SVG style of the existing icons).

Add i18n key in `src/lib/i18n.ts`:
```typescript
"nav.adminTemplateCandidates": { en: "Template Candidates", zh: "Template Candidates" },
```

(Per user's prior feedback, "Today" was set to English in both locales — match that convention for new admin nav entries.)

- [ ] **Step 2: tsc check + commit**

```bash
git add src/components/sidebar.tsx src/lib/i18n.ts
git commit -m "feat(templates): sidebar link for /admin/templates/candidates"
```

---

## Task 10: Smoke test in dry-mode

**Files:** none — verification only.

- [ ] **Step 1: Deploy via vercel-deploy skill**

- [ ] **Step 2: Trigger clustering cron in dry-mode**

```bash
SECRET=$(grep ^CRON_SECRET .env.local | cut -d= -f2- | tr -d '"')
curl -sS -H "Authorization: Bearer $SECRET" \
  "https://calistamind.com/api/cron/rep-edit-clustering?dry=1&x-vercel-protection-bypass=w0sh4eUwIoApjCrE5zuGtV7hGeuf906v" | jq
```

Expected: a per-rep summary with `edits_pulled`, `clusters_found`, `clusters_qualifying`, and `template_action` of `created` / `replaced` / `no_change` / `manual_template_in_place`.

- [ ] **Step 3: Trigger gate cron in dry-mode**

```bash
curl -sS -H "Authorization: Bearer $SECRET" \
  "https://calistamind.com/api/cron/candidate-global-promote?dry=1&x-vercel-protection-bypass=w0sh4eUwIoApjCrE5zuGtV7hGeuf906v" | jq
```

Expected: per-template gate evaluations. Most will likely show `skipped_reason: "sample size N < 30"` initially, since per-rep templates don't yet exist. After the first real (non-dry) clustering run, this should start finding candidates.

- [ ] **Step 4: First real run**

Once dry-mode looks sensible, trigger non-dry. The clustering cron will create per-rep templates. The gate cron will need 30+ sends per template before it can evaluate — that takes a week or two of normal rep activity.

No commit — operational verification.

---

## Open items deferred

- **Per-segment per-rep templates** — v1 only matches per-rep templates against a single global. If the org has multiple segment-specific globals (e.g., cn vs overseas defaults), the gate cron picks the active one matching the rep's modal segment.
- **Re-parsing edited HTML back into slot formats** — out of scope. v1 uses `full_html_override` as opaque storage.
- **Quality floor on per-rep templates** — a rep editing drafts to *worsen* them would still create a per-rep template; the two-signal gate filters them out for global promotion but doesn't block the per-rep template itself.
- **Inline diff view** — the page shows aggregate metrics; deep dive (medoid HTML side-by-side with current global) is a future enhancement.
