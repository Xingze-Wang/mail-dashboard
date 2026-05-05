-- migrations/042-contracts-capital.sql
-- 1. SCHEMA CHANGE
-- The action layer of the bench. A contract is one weekly commitment from
-- a company: "I will move metric M by ΔM in segment S, costing K capital,
-- expecting to land within the points target T by date D."
--
-- Three new tables:
--   company_contracts          — one row per weekly commitment
--   contract_event_attributions — many rows per contract (one per scored event)
--   investor_capital_ledger    — append-only weekly capital allocations + spends
--
-- 2. WHO WRITES
-- - company_contracts: api/contracts/open (company synthesizer commits a contract)
-- - contract_event_attributions: webhook handler at /api/webhook (every email event)
-- - investor_capital_ledger: api/investor/tick (weekly capital deployment)
--
-- 3. WHO READS
-- - /congress/timeline (dots are contracts)
-- - /api/investor/* (capital balance + contract performance)
-- - /analysis (rep view: which contract am I under right now)
-- - reweighter (uses attribution rows as training data)

create table if not exists company_contracts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references bench_companies(id) on delete cascade,
  -- the points-table version this contract was opened under (immutable for life of contract)
  points_version_id uuid not null references points_table_versions(id),
  -- target rep (null = whole company territory) and segment label (e.g. "Domestic (.cn)")
  rep_id integer references sales_reps(id) on delete set null,
  segment text,
  -- the action the contract commits to: short human label + structured payload
  action_label text not null,
  -- {kind: "template_swap" | "subject_test" | "routing_rule" | "pacing_change", details: {...}}
  action_spec jsonb not null default '{}',
  -- target_score is the minimum running_score the contract must reach to "hit"
  target_score numeric(10, 2) not null,
  running_score numeric(10, 2) not null default 0,
  -- capital staked when the contract opened (debited from investor pool; refunded with bonus on hit)
  capital_staked numeric(10, 2) not null,
  -- "open" | "hit" | "missed" | "cancelled"
  state text not null default 'open' check (state in ('open', 'hit', 'missed', 'cancelled')),
  opened_at timestamptz not null default now(),
  closes_at timestamptz not null,
  settled_at timestamptz,
  -- the company's prediction at open-time (for postmortem)
  prediction text not null default '',
  -- the postmortem written at settle-time (becomes episodic memory)
  postmortem text,
  created_at timestamptz not null default now()
);

create index if not exists company_contracts_company_state on company_contracts(company_id, state);
create index if not exists company_contracts_open_window on company_contracts(state, opened_at, closes_at);
create index if not exists company_contracts_rep_segment on company_contracts(rep_id, segment) where state = 'open';

create table if not exists contract_event_attributions (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references company_contracts(id) on delete cascade,
  -- which underlying event (foreign keys are loose; we just store the source ids)
  source_kind text not null,         -- "webhook_event" | "brief_lookup" | "submission" | "manual"
  source_id text,                     -- id of the underlying row
  event_kind text not null,           -- matches points_table_weights.event_kind
  points_awarded numeric(10, 3) not null,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists contract_attr_contract on contract_event_attributions(contract_id, occurred_at);
create index if not exists contract_attr_source on contract_event_attributions(source_kind, source_id);

-- ── Investor capital ledger ─────────────────────────────────────────
-- Replaces the conviction-as-feeling model. Each row is one capital
-- movement: pool top-up (start of week), stake (open contract), refund
-- (contract hit), forfeit (contract missed). Append-only.
create table if not exists investor_capital_ledger (
  id uuid primary key default gen_random_uuid(),
  investor_id uuid not null references investor_agents(id) on delete cascade,
  -- "pool_topup" | "stake" | "refund" | "forfeit" | "transfer"
  kind text not null,
  -- positive = capital added to investor's balance; negative = drawn down
  delta numeric(12, 2) not null,
  balance_after numeric(12, 2) not null,
  -- references for context
  contract_id uuid references company_contracts(id) on delete set null,
  company_id uuid references bench_companies(id) on delete set null,
  note text not null default '',
  occurred_at timestamptz not null default now()
);

create index if not exists investor_ledger_investor_time on investor_capital_ledger(investor_id, occurred_at desc);
create index if not exists investor_ledger_contract on investor_capital_ledger(contract_id);

-- Seed the Founder investor with a starting pool. Real allocation
-- happens via api/investor/topup later.
insert into investor_capital_ledger (investor_id, kind, delta, balance_after, note)
values ('00000000-0000-0000-0000-000000000001', 'pool_topup', 1000, 1000, 'Initial capital pool — seeded by migration 042.')
on conflict do nothing;
