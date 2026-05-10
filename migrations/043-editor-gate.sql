-- migrations/043-editor-gate.sql
-- 1. SCHEMA CHANGE
-- Editor gate: every company-proposed content change goes through a
-- brand-editor agent before it can ship. Two tables:
--   editor_reviews — one row per review (verdict + reasons)
--   editor_appeals — when a company contests an editor block
--
-- 2. WHO WRITES
-- editor_reviews: api/editor/review (auto when a contract carries a content change)
-- editor_appeals: api/editor/appeal (company submits) + admin decision
--
-- 3. WHO READS
-- - /editor admin queue (reviews pending appeal/admin attention)
-- - api/proposals/* (gate: pass/revise advances, block requires appeal)
-- - audit log when investigating "why did X ship?"
--
-- 4. BACKFILL FOR OLD ROWS
-- (d) not applicable — new tables, history starts now. Pre-existing
-- proposals and contracts have no review row; readers must treat
-- "no editor_reviews row" as ungated (legacy) rather than blocked.

create table if not exists editor_reviews (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid references company_contracts(id) on delete cascade,
  -- the proposed change being reviewed
  proposed_change jsonb not null,
  -- "pass" | "block" | "revise" — pass ships, block requires appeal/admin, revise gives suggested edits
  verdict text not null check (verdict in ('pass', 'block', 'revise')),
  -- structured: {issues: [string], suggestions: [string], severity: "minor"|"major"}
  feedback jsonb not null default '{}',
  -- raw editor agent output for debugging
  raw_output text not null default '',
  -- which prompt version was used (so we can swap editor identity over time)
  prompt_version text not null default 'qiji-v1',
  created_at timestamptz not null default now()
);

create index if not exists editor_reviews_contract on editor_reviews(contract_id);
create index if not exists editor_reviews_verdict on editor_reviews(verdict, created_at desc);

create table if not exists editor_appeals (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references editor_reviews(id) on delete cascade,
  company_id uuid not null references bench_companies(id) on delete cascade,
  -- the company's argument for why the editor's verdict should be overruled
  argument text not null,
  -- "pending" | "upheld" (admin overruled editor) | "denied" (admin agreed with editor) | "withdrawn"
  status text not null default 'pending' check (status in ('pending', 'upheld', 'denied', 'withdrawn')),
  decided_by integer references sales_reps(id) on delete set null,
  decided_at timestamptz,
  admin_note text,
  created_at timestamptz not null default now()
);

create index if not exists editor_appeals_status on editor_appeals(status, created_at desc);
