-- migrations/052-demand-signal.sql
-- 1. SCHEMA CHANGE
-- The demand-signal congress runs once (or whenever evidence shifts) to
-- decide *what* compute demand looks like in our recipient behavior:
-- which events count, how to weight them, how to dedup. The output is
-- a versioned definition that the scoring step uses.
--
-- Two tables:
--   demand_signal_definitions — one row per published version
--   demand_lead_scores         — per-lead observed-vs-predicted scores
--
-- 2. WHO WRITES
-- - demand_signal_definitions: api/scorer/demand/define (LLM congress)
-- - demand_lead_scores: api/scorer/demand/recompute (per-lead scorer)
--
-- 3. WHO READS   /scorer/demand UI
--
-- 4. BACKFILL FOR OLD ROWS
-- (d) not applicable — both tables are new. demand_lead_scores is
-- recomputed on demand by api/scorer/demand/recompute against the
-- current definition; there is no per-row history to migrate.

create table if not exists demand_signal_definitions (
  id uuid primary key default gen_random_uuid(),
  version int not null,
  -- The structured definition the congress voted on. Free-form jsonb so
  -- we can iterate. Expected fields:
  --   weights: {open: float, click: float, click_dedup_window_min: int,
  --             wechat: float, reply: float, ...}
  --   normalize: "z_score" | "minmax" | "none"
  --   threshold: float — score above this = strong demand
  --   rationale: string — the synthesizer's memo
  definition jsonb not null,
  -- Provenance
  proposed_by text not null default 'congress',
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  unique(version)
);

create index if not exists demand_def_active on demand_signal_definitions(effective_from, effective_to);

-- Per-lead observed score under the active definition + predicted score
-- from the existing live scorer. The diff is the interesting signal.
create table if not exists demand_lead_scores (
  id uuid primary key default gen_random_uuid(),
  lead_id text not null,
  definition_id uuid not null references demand_signal_definitions(id) on delete cascade,
  -- The score from observed events (clicks, wechats, replies) under the
  -- definition's weights.
  observed_score numeric(8, 4) not null,
  -- The score from the existing lead-quality scorer (local_score column
  -- on pipeline_leads). 0..1 if available, null otherwise.
  predicted_score numeric(8, 4),
  -- Difference. Positive = recipient showed more demand than scorer
  -- predicted (under-rated lead). Negative = recipient showed less.
  diff numeric(8, 4),
  -- Snapshot of the events that contributed.
  events jsonb not null default '{}',
  computed_at timestamptz not null default now()
);

create index if not exists demand_lead_scores_def on demand_lead_scores(definition_id, computed_at desc);
create index if not exists demand_lead_scores_lead on demand_lead_scores(lead_id, computed_at desc);
create index if not exists demand_lead_scores_diff on demand_lead_scores(definition_id, diff desc);
