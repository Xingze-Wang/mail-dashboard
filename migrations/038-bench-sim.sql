-- migrations/038-bench-sim.sql
-- 1. SCHEMA CHANGE: add bench_companies, bench_sim_sessions, bench_company_states, bench_step_results tables
-- 2. WHO WRITES: bench simulation API (POST /api/bench/sim)
-- 3. WHO READS: bench simulation API (GET /api/bench/sim), simulation dashboard
-- 4. BACKFILL: none — new tables

create table if not exists bench_companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  tagline text not null default '',
  deliberation_style text not null default 'balanced',
  model_roster jsonb not null default '{}',
  persona_overrides jsonb not null default '{}',
  customer_profile jsonb not null default '{}',
  color text not null default '#6366f1',
  created_at timestamptz not null default now()
);

create table if not exists bench_sim_sessions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  scenario_id text not null,
  company_ids uuid[] not null default '{}',
  steps_planned int not null default 4,
  steps_completed int not null default 0,
  cross_company_visibility boolean not null default true,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create table if not exists bench_company_states (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references bench_sim_sessions(id) on delete cascade,
  company_id uuid not null references bench_companies(id) on delete cascade,
  step int not null,
  state jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique(session_id, company_id, step)
);

create table if not exists bench_step_results (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references bench_sim_sessions(id) on delete cascade,
  company_id uuid not null references bench_companies(id) on delete cascade,
  step int not null,
  loop text not null,
  personas jsonb not null default '{}',
  recommendation text,
  confidence float,
  change_spec jsonb,
  rationale text,
  extra_fields jsonb not null default '{}',
  latency_s float,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists bench_step_results_session_step on bench_step_results(session_id, step);
