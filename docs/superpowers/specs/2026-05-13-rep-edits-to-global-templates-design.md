# Rep edits → per-rep templates → candidate global templates

**Date:** 2026-05-13
**Author:** Xingze (with Claude)
**Status:** Draft

## Problem

Today, when a sales rep consistently edits the AI draft in a particular way (e.g., Leo always shortens the school-pitch paragraph; Yujie always rephrases the opening), that pattern lives only in the diffs on `pipeline_leads.draft_html` vs `draft_original_html`. The drift-mining cron (`/api/cron/drift/mine`) detects org-wide patterns and writes them to `prompt_drift_patterns` for admin review — but it does **not** turn them into actual templates, and it does **not** distinguish per-rep style from org-wide complaint.

Meanwhile, the existing template promotion loop (`/api/cron/template-auto-promote`) only promotes templates that **already exist** as `email_templates` rows. There's no path from "Leo's recurring edit" to "Leo gets his own template" to "Leo's template should be the global default."

We have two prediction signals that *aren't being used together*:

1. **Actual click-through rate** — measured per `template_id` from `emails` × `webhook_events`
2. **CTR-regressor predicted `p_click`** — `model-bench` system already scores every email daily via the winning `ctr_regressor` prompt, accumulated in `model_predictions`

Single-signal promotion is risky:
- Actual-only: 30 sends is the floor for Wilson CI, but a fluky day still passes
- Predicted-only: model could be miscalibrated; no ground truth

Two-signal **agreement** is the bar that makes this auto-surface safe.

## Goals

1. **Detect** when a rep consistently edits AI drafts in the same way (≥5 occurrences, cosine similarity ≥ 0.85)
2. **Materialize** the rep's recurring edit pattern as a per-rep `email_templates` row with `rep_id={N}`, status `active` (only that rep uses it)
3. **Measure** each per-rep template against the global baseline using both **actual** clicks (Wilson 95% CI) and **predicted** clicks (avg `p_click` from `model_predictions`)
4. **Surface** to admin as a "candidate global template" only when both signals exceed baseline + the gate threshold, with full evidence
5. **Hand off** admin approval → existing template-auto-promote loop (proposal → approved_draft → active)

## Non-goals

- **Not changing the existing drift-mining loop.** `prompt_drift_patterns` continues to detect org-wide edit patterns for prompt-engineering review; that's about the *underlying intro_prompt*, not the rendered template. Out of scope.
- **Not adding a new ML model.** Reuses `ctr_regressor` from `model-bench`.
- **Not auto-promoting to global.** Admin approval is required. The cron only *surfaces* candidates.
- **Not changing the rep-edit capture path.** `draft_original_html` vs `draft_html` + `edit_reasons[]` continue to be the source of truth.
- **Not building per-rep templates for everyone.** Only reps who have a clear edit pattern (≥5 similar edits in last 30 days) get one — most reps stay on the global.

## High-level architecture

```
                          ┌─────────────────────────────────────┐
Existing capture          │ pipeline_leads (every send)         │
(unchanged)               │  - draft_original_html (AI)         │
                          │  - draft_html (rep's edit)          │
                          │  - draft_edit_distance              │
                          │  - edit_reasons[]                   │
                          │  - template_id (which template won) │
                          └──────────────┬──────────────────────┘
                                         │
                                         ▼
                          ┌─────────────────────────────────────┐
NEW: weekly cron          │ /api/cron/rep-edit-clustering        │
(Mon 02:00 Beijing,       │  ─ embed each rep's last 30d edits  │
 after drift-mining)      │  ─ cluster: cosine ≥ 0.85           │
                          │  ─ cluster ≥ 5 → materialize        │
                          └──────────────┬──────────────────────┘
                                         │
                                         ▼
                          ┌─────────────────────────────────────┐
                          │ email_templates row created          │
                          │  rep_id={N}                          │
                          │  status='active', active=true        │
                          │  proposed_by='rep_edit_cluster'      │
                          │  proposed_evidence = cluster data    │
                          └──────────────┬──────────────────────┘
                                         │ (used by send route via
                                         │  existing per-rep override)
                                         ▼
                          ┌─────────────────────────────────────┐
                          │ pipeline_leads.template_id stamped   │
                          │  → emails.template_id stamped        │
                          │  → ctr_regressor runs daily,         │
                          │     model_predictions accumulate     │
                          │  → click webhook events arrive       │
                          └──────────────┬──────────────────────┘
                                         │
                                         ▼
                          ┌─────────────────────────────────────┐
NEW: weekly cron          │ /api/cron/candidate-global-promote   │
(Mon 03:00 Beijing)       │  for each per-rep template:          │
                          │   ─ wait until ≥30 sends             │
                          │   ─ Wilson CI actual > global UB     │
                          │   ─ avg p_click > global avg p_click │
                          │   ─ BOTH agree → write candidate     │
                          └──────────────┬──────────────────────┘
                                         │
                                         ▼
                          ┌─────────────────────────────────────┐
                          │ admin_inbox row                      │
                          │  kind='candidate_global_template'    │
                          │  headline='Leo's template beats      │
                          │            global on both signals'   │
                          │  evidence = side-by-side metrics     │
                          └──────────────┬──────────────────────┘
                                         │
                                         ▼
                          ┌─────────────────────────────────────┐
                          │ /admin/templates/candidates page     │
                          │  ─ side-by-side: per-rep vs global   │
                          │  ─ both signals visualized           │
                          │  ─ "Promote to global proposal"      │
                          │  ─ "Reject — keep per-rep only"      │
                          └──────────────┬──────────────────────┘
                                         │ approve
                                         ▼
                          ┌─────────────────────────────────────┐
                          │ Existing template-auto-promote loop  │
                          │  ─ new email_templates row created    │
                          │    with rep_id=NULL, status='proposal'│
                          │    cloned content from per-rep template│
                          │  ─ enters existing approval workflow   │
                          └─────────────────────────────────────┘
```

## Detailed design

### 1. Edit clustering: from raw diffs to a "pattern"

**Trigger:** Weekly cron `/api/cron/rep-edit-clustering` at `0 18 * * 0` (Sun 18:00 UTC = Mon 02:00 Beijing). Runs after the existing drift-mining cron.

**Input:** For each `role='sales'` rep, pull last 30 days of leads where:
- `status = 'sent'` (rep actually edited and sent)
- `draft_edit_distance > 50` (meaningful edit, not a typo fix)
- `draft_original_html IS NOT NULL` AND `draft_html IS NOT NULL`

**Algorithm:**

```
for each rep:
  edits = pull last 30d of (lead.id, original_html, edited_html)
    filtered by draft_edit_distance > 50
  if |edits| < 5: skip this rep  # too little data
  
  # Embed the EDITED version (the rep's preferred phrasing)
  for each edit:
    text = strip_html(edited_html)[:2000]
    vec = embedText(text)  # 1536-dim
  
  # Greedy single-linkage clustering — O(n²), n ≤ ~30, cheap
  clusters = []
  for each edit:
    assigned = false
    for each cluster in clusters:
      if cosine(edit.vec, cluster.centroid) ≥ 0.85:
        cluster.members.append(edit)
        cluster.centroid = mean(cluster.members.vec)
        assigned = true
        break
    if not assigned:
      clusters.append({members: [edit], centroid: edit.vec})
  
  # Keep only clusters with ≥ 5 members
  significant = [c for c in clusters if len(c.members) >= 5]
  
  for cluster in significant:
    # The "canonical" template = the medoid (closest to centroid)
    medoid = argmin_member( distance(member.vec, cluster.centroid) )
    materialize_per_rep_template(rep_id, medoid.edited_html, cluster)
```

**Why embeddings + clustering, not regex:** The same pattern can be phrased five different ways ("I noticed you work on diffusion at Tsinghua" / "I see you do work in diffusion models — Tsinghua is doing great work there" / etc.). Regex/substring would miss these. 1536-dim embedding cosine ≥ 0.85 catches them.

**Why medoid, not centroid:** Centroid is a synthetic vector with no actual text. Medoid is the real edit closest to it — we can use its actual HTML as the template.

**Storage of cluster evidence:** Inline in the new `email_templates` row's `proposed_evidence` JSONB. No new table needed.

### 2. Materializing a per-rep template

When a cluster qualifies (≥5 members), create an `email_templates` row:

```sql
INSERT INTO email_templates (
  name,
  rep_id,
  active,
  status,
  proposed_by,
  proposed_reason,
  proposed_evidence,
  -- copy all the slot fields from the medoid's parsed structure:
  subject_format,
  intro_prompt,
  greeting_format,
  rep_intro_format,
  school_pitch_format,
  cta_signoff_format,
  notes
) VALUES (...);
```

Key fields:
- `name`: `"{Rep name}'s edit pattern ({cluster size})"` — e.g., `"Yujie's edit pattern (12 edits)"`
- `rep_id`: the rep's id
- `status`: `'active'` (immediately starts being used for that rep — no admin approval needed, since the rep is *already* editing this way every time)
- `proposed_by`: `'rep_edit_cluster'` (new value alongside existing `'congress'`)
- `proposed_evidence`: structured JSON:

```json
{
  "cluster_size": 12,
  "sample_lead_ids": ["uuid-1", "uuid-2", ...up to 10],
  "centroid_similarity": 0.91,
  "medoid_lead_id": "uuid-3",
  "detection_run_at": "2026-05-13T18:05:00Z",
  "dedup_key": "rep-edit-cluster-{rep_id}-{medoid_lead_id}"
}
```

**Replacement semantics:** If a rep already has an `active` per-rep template with `proposed_by='rep_edit_cluster'`, and a NEW cluster qualifies that doesn't match the existing one (centroid cosine < 0.85), the old one is archived and the new one becomes active. This handles "Leo's style evolved" — but it's gated so it only happens when the new pattern is statistically robust (≥5 fresh edits in the last 30d).

If the rep has an `active` per-rep template that was created *manually* (`proposed_by != 'rep_edit_cluster'`), it is **not** touched. Admin-created templates win over auto-detected ones.

### 3. Parsing rendered HTML back into template slots

This is the tricky part: the cluster contains edited *rendered* HTML, but `email_templates` stores **slot formats** (subject_format, greeting_format, rep_intro_format, etc.). To materialize a template from a rendered edit, we need to either:

- **Option A:** Store the entire edited HTML as a single override field, treating it as opaque
- **Option B:** Parse the HTML back into slots using the existing rendering structure as a template

**Option A** is simpler and safer for v1. Add a new column `email_templates.full_html_override TEXT` (nullable). When set, the template-assembler uses it directly instead of rendering from slots. When NULL, normal slot-based render applies.

This means rep-edit-derived templates **lose the ability to mix-and-match slots**, but for v1 that's fine — the whole point is the rep's full edit is the template. Future enhancement could re-parse.

Migration adds:
```sql
ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS full_html_override TEXT;
ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS subject_override TEXT;
```

`template-assembler.ts` checks: if `full_html_override` is set, use it (with placeholders refilled). Otherwise fall back to slot-based rendering.

### 4. Two-signal gate: when does a per-rep template become a global candidate?

**Trigger:** Weekly cron `/api/cron/candidate-global-promote` at `0 19 * * 0` (Sun 19:00 UTC = Mon 03:00 Beijing). Runs 1 hour after the clustering cron, so any new per-rep template from this morning has its evidence written.

**For each per-rep template** (rep_id IS NOT NULL, status='active'):

1. **Sample size gate:** Pull last 30 days of `emails` where `template_id = this template`. Skip if `count < 30`.

2. **Compute actual click rate (Wilson 95% CI):**
   - `clicked = count of webhook_events with type='email.clicked' for these email_ids`
   - `wilson_lower, wilson_upper = wilson_interval(clicked, total, 0.95)`

3. **Compute predicted click rate (from model_predictions):**
   - For each email_id in the sample, fetch `model_predictions.headline` (= `p_click`) for the active `ctr_regressor` prompt
   - `avg_predicted = mean(p_click)` over the available predictions
   - Skip if fewer than 20 predictions exist (model coverage is thin)

4. **Compute global baseline:**
   - Find the active `email_templates.rep_id IS NULL` row (the org-wide default)
   - For its last 30d of emails: compute Wilson CI of actual clicks AND avg predicted p_click
   - If multiple global templates exist (e.g., per-segment), match the per-rep template to the segment most leads in its sample belong to

5. **Two-signal agreement gate:**
   - **Actual signal:** `per_rep.wilson_lower > global.wilson_upper`  
     (per-rep lower bound exceeds global upper bound — Wilson non-overlap, conservative)
   - **Predicted signal:** `per_rep.avg_predicted > global.avg_predicted * 1.1`  
     (per-rep predicted CTR ≥ 10% relative lift over global)
   - **Both must hold.** Either alone is insufficient.

6. **Idempotent inbox write:** If both gates pass, upsert `admin_inbox` row with:

```sql
INSERT INTO admin_inbox (
  kind,
  headline,
  body,
  evidence,
  status,
  dedup_hash
) VALUES (
  'candidate_global_template',
  'Per-rep template for Leo beats global on both signals',
  '...full markdown explanation...',
  {
    "rep_id": 1,
    "per_rep_template_id": "uuid",
    "global_template_id": "uuid",
    "sample_size": 47,
    "actual_per_rep": {clicked, sent, rate, wilson_lower, wilson_upper},
    "actual_global":  {clicked, sent, rate, wilson_lower, wilson_upper},
    "predicted_per_rep": 0.183,
    "predicted_global":  0.142,
    "relative_lift_predicted": 0.29,
    "decision_run_at": "..."
  },
  'pending',
  'candidate-global-{per_rep_template_id}'
)
ON CONFLICT (dedup_hash) DO UPDATE
  SET evidence = EXCLUDED.evidence,
      headline = EXCLUDED.headline,
      body = EXCLUDED.body;
```

**Decay:** If a per-rep template no longer beats global (gate fails on a re-run), the existing `admin_inbox` row is left alone IF the admin already acted (status != 'pending'). If still pending, it's archived (`status='dismissed_by_system'`) with a note that the evidence changed.

### 5. Admin candidate-queue UI

**New page:** `/admin/templates/candidates`

Sections:
- **Pending candidates** — table: rep name | per-rep template name | actual lift | predicted lift | sample size | "Review" button
- **Approved/dismissed history** — read-only, last 30d

**Review modal** (or detail page):
- Side-by-side HTML preview: per-rep template vs current global
- Bar chart: actual CTR (with Wilson CI bands) per-rep vs global
- Bar chart: avg predicted p_click per-rep vs global
- "Promote to global proposal" button — POST writes a new `email_templates` row with:
  - `rep_id = NULL` (global)
  - `status = 'proposal'`
  - `proposed_by = 'admin_from_rep_edit'`
  - `proposed_evidence` cloned from the candidate
  - Content cloned from the per-rep template
  - → admin can then approve via the existing `/templates/bench` review flow → `approved_draft` → traffic-split → existing auto-promote cron
- "Reject — keep per-rep only" button — marks the inbox row `status='dismissed'`, no other side effect (per-rep template stays active for that rep)

### 6. Reusing the existing template-auto-promote pipeline

After admin clicks "Promote to global proposal," the new global proposal enters the **existing** pipeline:

1. Lands as `email_templates` row with `status='proposal'`
2. Admin reviews on `/templates/bench` → clicks "Approve Draft" → `status='approved_draft'`
3. 20% of org-wide traffic routes through it (existing A/B logic in `template-assembler.ts`)
4. Existing `/api/cron/template-auto-promote` runs daily, applies Wilson CI test against current active global
5. If proposal wins → flipped to `status='active'`, old active archived

No changes needed to that pipeline. The new work just adds an *entry point* upstream of it.

### 7. Edge cases & guards

**Rep doesn't edit much:** Skipped at the `|edits| < 5` filter. No per-rep template created.

**Rep edits inconsistently:** Embeddings scatter, no cluster of ≥5 forms. Skipped.

**Rep started a per-rep template manually:** Auto-clustering won't override it. Admin can still see candidate suggestions in the inbox.

**Multiple clusters per rep:** Take the *largest* cluster per rep (most edits). One per-rep template per rep, period. Future enhancement: per-segment per-rep templates.

**ctr_regressor predictions missing for some emails:** Use whatever's available, require ≥20 predictions before evaluating predicted signal. If fewer, skip the predicted gate and leave the candidate in a "pending: more data needed" state in admin_inbox.

**Test mode:** A `?dry=1` query param on both cron routes — runs the algorithm and returns what would happen without writing anything. Admin uses this from `/admin/allocation`-style cockpit.

**Sentinel reason on overrides:** Like the existing `_quota_check_dm_marker` pattern, marker rows in `admin_inbox` with `kind='candidate_global_template'` are deduped via `dedup_hash` so cron re-runs don't spam.

## Migration

**Migration 083** — additive only:

```sql
-- 1. SCHEMA CHANGE
-- Add full_html_override columns to email_templates so rep-edit-derived
-- templates can store the rep's full edit verbatim (without re-parsing
-- back into slot formats).
--
-- 2. WHO WRITES THIS?
-- /api/cron/rep-edit-clustering writes these when materializing a
-- per-rep template from a cluster of similar edits.
--
-- 3. WHO READS THIS?
-- src/lib/template-assembler.ts — assembleDraft() checks override first,
-- falls back to slot-based rendering if null.
--
-- 4. BACKFILL FOR OLD ROWS
-- (c) intentionally NULL for legacy templates — they continue to use
-- the slot-based path. No legacy row needs overrides.

ALTER TABLE email_templates
  ADD COLUMN IF NOT EXISTS full_html_override TEXT,
  ADD COLUMN IF NOT EXISTS subject_override TEXT;
```

No new tables. `admin_inbox` already exists with `kind` + `dedup_hash`.

## Success criteria

After 4 weeks of running:

1. **At least 1 per-rep template** auto-materialized for at least 1 rep (proves clustering works on real data)
2. **At least 1 candidate** surfaced to admin_inbox via the two-signal gate (proves the loop closes)
3. **0 false dups** — same per-rep edit pattern doesn't create duplicate templates on re-run (idempotency)
4. **No regression in send volume or click rate** — measured org-wide week-over-week

If none of (1)/(2) fires, the gate is too tight or reps aren't editing enough. Lower the cluster threshold from 5 to 3, or the predicted-lift gate from 1.1 to 1.05.

## Open questions (default decisions in spec, flag if you disagree)

1. **Cluster threshold:** ≥5 members. Lower means more sensitive but noisier. Higher means more conservative. Started at 5.
2. **Cosine threshold:** ≥0.85. Higher = stricter "same pattern" definition. Tested empirically against the existing prompt_drift_patterns — patterns there typically embed at 0.87+.
3. **Predicted lift:** ≥1.1 (10%). Could be 1.05 (more candidates) or 1.2 (more conservative).
4. **Wilson CI alpha:** 95% (matches existing template-auto-promote). Consistent.
5. **Replacement of self-clusters:** Replace if new cluster ≥5 fresh edits in 30d AND old cluster's last edit is >14 days old. Configurable.

## Out of scope (deferred)

- **Per-segment per-rep templates** — only one per-rep template per rep for v1
- **Re-parsing edited HTML back into slot formats** — Option A only for v1
- **Real-time edit detection** — clustering runs weekly, not on every send
- **Cross-rep pattern detection** — that's the existing drift-mining loop's job
- **Adversarial / bad-pattern detection** — if a rep edits drafts to make them worse, the two-signal gate filters that out at the global candidate step but won't block the per-rep template from being created. Could add a quality-score floor later.
