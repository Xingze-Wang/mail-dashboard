-- migrations/040-investor-agents.sql
-- 1. SCHEMA CHANGE
-- Add investor framing on top of bench_companies. Three new tables:
--   investor_agents     — one row per investor persona (Sequoia-style,
--                         a16z-style, bear, etc). Holds the prompt and
--                         long-term memory the investor uses to decide.
--   investor_bets       — investor × company conviction. Updated each
--                         tick by the investor agent (or by the user
--                         until the agent runs).
--   company_lifecycle   — chronological events on a company (funded,
--                         first ship, first conversion, thesis revised,
--                         conviction change). Powers the "company
--                         timeline" museum view.
--
-- Plus columns on bench_companies:
--   thesis (text)       — investor's bet on what this company wins at
--   target_segment      — denormalized from customer_profile.segment so
--                         metric joins don't have to dig into jsonb
--   funded_by           — investor_agent_id or null (= user-funded)
--   funded_at           — timestamp of original funding event
--   active              — true while in portfolio; false after cut
--
-- 2. WHO WRITES
-- bench_companies.thesis/target_segment/funded_by/funded_at: api/investor/*, api/bench/sim/companies
-- investor_agents: seeded by hand (script + this migration's defaults)
-- investor_bets: api/investor/tick (writes after each portfolio review)
-- company_lifecycle: api/bench/sim (on company create), api/investor/tick (on conviction change), runners (on first ship/conversion)
--
-- 3. WHO READS
-- /congress/timeline (companies + loops view)
-- /api/investor/* (agent reasoning loop)
-- /analysis (insights — surfaces investor takes)
--
-- 4. BACKFILL
-- (b) one-time backfill: insert a "Founder" investor_agent (the user)
--     with id stable across envs so existing bench_companies rows can
--     be attributed to it.

-- ── Investor agents ──────────────────────────────────────────────
create table if not exists investor_agents (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  style text not null default 'balanced',
  -- The system prompt that defines this investor's worldview.
  -- Sequoia: "find $1B outcomes, miss $100M ones." a16z: "build the
  -- market, even if it loses for 3 years." Bear: "every thesis is
  -- wrong until proven; cut at first miss."
  system_prompt text not null,
  -- Long-term memory — facts the investor learned across portfolio
  -- reviews. Append-only via the api.
  memory jsonb not null default '[]',
  -- The starting conviction this investor assigns when funding a
  -- new company; used by the agent to anchor first tick.
  default_conviction float not null default 0.5,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists investor_agents_active on investor_agents(active);

-- Stable seed: the "Founder" investor — represents the user manually
-- funding companies before any LLM-backed agent runs. Stable id so
-- attribution works across envs.
insert into investor_agents (id, name, style, system_prompt, default_conviction)
values (
  '00000000-0000-0000-0000-000000000001',
  'Founder',
  'manual',
  'You are the user. Companies you fund reflect your direct judgment, not an automated thesis. Conviction defaults to 0.7 because you only fund what you believe.',
  0.7
)
on conflict (id) do nothing;

-- ── Bets ─────────────────────────────────────────────────────────
-- One row per (investor, company) conviction snapshot. We keep all
-- snapshots — never overwrite — so the timeline can show conviction
-- evolution.
create table if not exists investor_bets (
  id uuid primary key default gen_random_uuid(),
  investor_id uuid not null references investor_agents(id) on delete cascade,
  company_id uuid not null references bench_companies(id) on delete cascade,
  conviction float not null check (conviction >= 0 and conviction <= 1),
  -- "double_down" | "hold" | "trim" | "cut" | "fund"
  action text not null,
  -- The note the investor wrote at this tick.
  rationale text not null default '',
  -- Metric snapshot at the time of the bet — investor reasons on
  -- target-segment-scoped numbers, not org-wide.
  metric_snapshot jsonb not null default '{}',
  decided_at timestamptz not null default now()
);

create index if not exists investor_bets_company_time on investor_bets(company_id, decided_at desc);
create index if not exists investor_bets_investor_time on investor_bets(investor_id, decided_at desc);

-- ── Lifecycle events ─────────────────────────────────────────────
-- Chronological company events. Mix of system-generated (first ship,
-- first conversion) and investor-generated (funded, conviction change,
-- cut).
create table if not exists company_lifecycle (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references bench_companies(id) on delete cascade,
  -- "funded" | "thesis_revised" | "first_proposal" | "first_ship"
  -- | "first_conversion" | "conviction_change" | "cut" | "milestone"
  event text not null,
  -- One-line human label shown on the timeline dot.
  label text not null,
  -- Anything contextual — investor_id, metric values at time of event,
  -- proposal_id that triggered first_ship, etc.
  meta jsonb not null default '{}',
  occurred_at timestamptz not null default now()
);

create index if not exists company_lifecycle_company_time on company_lifecycle(company_id, occurred_at);

-- ── bench_companies extensions ───────────────────────────────────
-- thesis, target_segment, funded_by, funded_at, active
alter table bench_companies add column if not exists thesis text;
alter table bench_companies add column if not exists target_segment text;
alter table bench_companies add column if not exists funded_by uuid references investor_agents(id) on delete set null;
alter table bench_companies add column if not exists funded_at timestamptz default now();
alter table bench_companies add column if not exists active boolean not null default true;

-- Backfill existing companies as funded by the Founder.
update bench_companies
set funded_by = '00000000-0000-0000-0000-000000000001'::uuid
where funded_by is null;

-- Pull target_segment out of customer_profile jsonb if it's there.
update bench_companies
set target_segment = customer_profile->>'segment'
where target_segment is null and customer_profile ? 'segment';

create index if not exists bench_companies_funded_by on bench_companies(funded_by);
create index if not exists bench_companies_active on bench_companies(active);
