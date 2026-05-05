-- migrations/041-points-economy.sql
-- 1. SCHEMA CHANGE
-- Versioned points table — the funnel's "law of physics". Each version is
-- a frozen snapshot: weights + uncertainty + fit metadata + the data window
-- it was fit on. Old contracts settle under the version active at their
-- creation time; new contracts use the current version.
--
-- Two tables:
--   points_table_versions  — one row per published version
--   points_table_weights   — one row per (version, event_kind), the actual weights
--
-- 2. WHO WRITES
-- - Initial seed: this migration (manual hand-picked weights)
-- - Investor-published manual updates: api/investor/points/publish (later)
-- - Auto-fit reweighter: scripts/reweight-points.mjs (later)
--
-- 3. WHO READS
-- - Event-to-contract attribution (computes points per event)
-- - Company synthesizer (knows current weights when proposing contracts)
-- - Investor view (shows weight drift + uncertainty)
-- - Timeline (annotates major weight version changes)
--
-- 4. BACKFILL
-- (b) seed v1 with hand-picked weights — every existing event will retroactively
--     attribute under v1 if/when a backfill is run.

create table if not exists points_table_versions (
  id uuid primary key default gen_random_uuid(),
  -- monotonic version number for human reference
  version int not null,
  -- "manual" | "auto_fit" | "investor_override"
  source text not null,
  -- when this version became active. The previous version's effective_to is
  -- set to this value when this row is published.
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  -- which investor (if any) published this version
  published_by uuid references investor_agents(id) on delete set null,
  -- fit metadata: data window, sample size, model used. Free-form jsonb.
  fit_metadata jsonb not null default '{}',
  -- one-line description of what changed and why
  rationale text not null default '',
  created_at timestamptz not null default now(),
  unique(version)
);

create index if not exists points_table_versions_active on points_table_versions(effective_from, effective_to);

create table if not exists points_table_weights (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references points_table_versions(id) on delete cascade,
  -- "submission" | "wechat" | "click" | "reply" | "open" | "delivered" | future events
  event_kind text not null,
  -- the points awarded when this event fires
  weight numeric(8, 3) not null,
  -- 1-sigma uncertainty on the weight (from regression). 0 if hand-picked.
  weight_uncertainty numeric(8, 3) not null default 0,
  -- "terminal" events have weight set by humans, not by reweighter (e.g. submission)
  is_terminal boolean not null default false,
  unique(version_id, event_kind)
);

-- ── Seed v1 with hand-picked weights ────────────────────────────────
-- Submission is terminal and worth most; click is the high-volume mid-funnel
-- signal; wechat is currently abundant so weighted lower than click; open
-- is too cheap to mean much.
insert into points_table_versions (id, version, source, effective_from, rationale)
values ('00000000-0000-0000-0000-000000000041', 1, 'manual', now(), 'Hand-picked v1: submission=10, reply=4, click=3, wechat=2, open=0.2. Anchors the system before regression fits arrive.')
on conflict (version) do nothing;

insert into points_table_weights (version_id, event_kind, weight, is_terminal) values
  ('00000000-0000-0000-0000-000000000041', 'submission', 10.0, true),
  ('00000000-0000-0000-0000-000000000041', 'reply',       4.0, false),
  ('00000000-0000-0000-0000-000000000041', 'click',       3.0, false),
  ('00000000-0000-0000-0000-000000000041', 'wechat',      2.0, false),
  ('00000000-0000-0000-0000-000000000041', 'open',        0.2, false),
  ('00000000-0000-0000-0000-000000000041', 'delivered',   0.0, false)
on conflict (version_id, event_kind) do nothing;
