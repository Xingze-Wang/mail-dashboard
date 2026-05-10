-- migrations/044-company-memory.sql
-- 1. SCHEMA CHANGE
-- Three layers of memory per company:
--   company_episodic_memory  — the company's track record (one row per settled contract)
--   company_semantic_memory  — extracted patterns the company has learned
--   company_procedural_memory — versioned snapshots of the company's own prompts
--
-- Plus rep_operating_profile — system-of-record memory about each rep's
-- execution behavior, queryable by companies during deliberation.
--
-- 2. WHO WRITES
-- episodic: settleContract() in lib/contracts.ts (auto on settle)
-- semantic: company synthesizer at end of weekly deliberation (LLM emits patterns)
-- procedural: api/companies/{id}/prompts/publish (manual or auto-evolution)
-- rep_operating_profile: triggered re-compute on event-stream (or nightly)
--
-- 3. WHO READS
-- - All three: company synthesizer at start of weekly deliberation (the company "remembers")
-- - episodic + procedural: investor (reading résumé before allocating capital)
-- - rep_operating_profile: companies during territory bidding
--
-- 4. BACKFILL FOR OLD ROWS
-- (d) not applicable — episodic and procedural memory are new tables that
-- start writing from this migration forward. rep_operating_profile is
-- (b) backfilled lazily: the nightly recompute job populates a row per
-- rep on first run; consumers must tolerate "no profile row yet" by
-- falling back to defaults rather than crashing.

create table if not exists company_episodic_memory (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references bench_companies(id) on delete cascade,
  contract_id uuid not null references company_contracts(id) on delete cascade,
  -- summary of what happened in <= 3 sentences
  summary text not null,
  -- {prediction, action, outcome, points_landed, points_target, surprise: bool}
  details jsonb not null default '{}',
  occurred_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists company_ep_company_time on company_episodic_memory(company_id, occurred_at desc);

create table if not exists company_semantic_memory (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references bench_companies(id) on delete cascade,
  -- "pattern" | "heuristic" | "constraint" | "hypothesis"
  kind text not null,
  -- the pattern itself (one sentence)
  body text not null,
  -- evidence: which contract_ids / event_ids support this pattern
  evidence jsonb not null default '{}',
  -- 0..1, how much the company trusts this pattern
  confidence numeric(4, 3) not null default 0.5,
  -- when this pattern was last updated by deliberation
  last_seen timestamptz not null default now(),
  -- if a pattern is contradicted by later evidence, set to false; never delete
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists company_sem_company_active on company_semantic_memory(company_id, active);
create index if not exists company_sem_confidence on company_semantic_memory(company_id, confidence desc);

create table if not exists company_procedural_memory (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references bench_companies(id) on delete cascade,
  -- which slot of the prompt: "synthesizer" | "adversary" | "deliberation_style" | etc
  slot text not null,
  -- the prompt content
  prompt_body text not null,
  -- monotonic per (company, slot) so we can show "v3 → v4 swap"
  version int not null,
  -- author of this version: investor_id or "self" (the company evolved itself)
  authored_by text not null default 'self',
  rationale text not null default '',
  -- only one row per (company, slot) is "active"; others are history
  active boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists company_proc_active on company_procedural_memory(company_id, slot) where active = true;
create index if not exists company_proc_history on company_procedural_memory(company_id, slot, version desc);

-- ── rep_operating_profile ───────────────────────────────────────────
-- One row per rep. Recomputed by a job. Holds the system's structured
-- view of each rep's execution behavior.
create table if not exists rep_operating_profile (
  rep_id integer primary key references sales_reps(id) on delete cascade,
  -- per-segment performance, e.g. {"Domestic (.cn)": {ctr: 0.06, conv: 0.08, sample: 240}}
  segment_performance jsonb not null default '{}',
  -- override behavior: when the company directs X and rep does Y
  override_rate numeric(4, 3) not null default 0,
  override_outcomes jsonb not null default '{}', -- {wins: 3, losses: 5, neutral: 2}
  -- median seconds from "lead surfaced" to "first action"
  response_speed_p50_s integer,
  -- the kinds of contracts the rep tends to execute well/poorly
  fit_summary text,
  recomputed_at timestamptz not null default now()
);
