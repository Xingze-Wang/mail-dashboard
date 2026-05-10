-- migrations/046-proposal-queue.sql
-- 1. SCHEMA CHANGE
-- Advisory-only chokepoint for company actions. Companies (and any agent)
-- never directly write to pipeline_leads, emails, email_templates, etc.
-- They submit proposals; an admin (or auto-execute path on green-light)
-- materializes the change.
--
-- This is the single audit trail for "what did the system change and on
-- whose recommendation." Execute path lives separately and only runs on
-- approved proposals.
--
-- 2. WHO WRITES
-- - company_proposals INSERT: api/proposals POST (company synth or any agent submits)
-- - editor_verdict update: editor gate, after running reviewContent()
-- - admin_decision update: api/proposals/decide (admin approves/rejects)
-- - executed_at update: api/proposals/execute (the materialization step)
--
-- 3. WHO READS
-- - /editor admin queue (filter where state='admin_review')
-- - /congress/timeline (proposal lifecycle dots per company)
-- - investor tick (counts as outcome signal: did the proposal land?)
-- - reweighter (not directly — proposals are upstream of events)
--
-- 4. BACKFILL FOR OLD ROWS
-- (d) not applicable — new table. Pre-existing direct writes to
-- pipeline_leads / emails / email_templates were not made through any
-- proposal record; they remain unattributed historical changes and
-- readers must treat "no proposal" as legacy admin action rather than
-- a missing row.

create table if not exists company_proposals (
  id uuid primary key default gen_random_uuid(),
  -- who proposed
  company_id uuid not null references bench_companies(id) on delete cascade,
  contract_id uuid references company_contracts(id) on delete set null,
  investor_id uuid references investor_agents(id) on delete set null,
  -- what kind of change
  -- "template_swap" | "subject_test" | "routing_rule" | "pacing_change"
  -- | "lead_skip" | "draft_revise" | "segment_target_shift"
  kind text not null,
  -- machine-executable spec for the change. Schema is per-kind.
  -- Example for template_swap: { template_id, new_subject, new_body_html, segment }
  payload jsonb not null,
  -- what real-world rows would be touched if approved (for audit + dry-run)
  -- e.g. {"emails": ["uuid1", ...], "pipeline_leads": ["uuid2", ...]}
  affected_targets jsonb not null default '{}',
  -- the company's prediction: what happens if this ships
  prediction text not null default '',
  -- ── lifecycle ────────────────────────────────────────────────
  -- "pending" → editor_review → admin_review → approved/rejected → executed
  state text not null default 'pending' check (state in (
    'pending', 'editor_review', 'admin_review', 'approved', 'rejected', 'executed', 'expired', 'withdrawn'
  )),
  editor_review_id uuid references editor_reviews(id) on delete set null,
  admin_decision text check (admin_decision in (null, 'approved', 'rejected', 'deferred')),
  admin_decided_by integer references sales_reps(id) on delete set null,
  admin_decided_at timestamptz,
  admin_note text,
  executed_at timestamptz,
  execution_result jsonb,
  -- proposals expire if nobody decides — auto-rejected to keep queue clean
  expires_at timestamptz not null default (now() + interval '7 days'),
  created_at timestamptz not null default now()
);

create index if not exists company_proposals_state on company_proposals(state, created_at desc);
create index if not exists company_proposals_company on company_proposals(company_id, created_at desc);
create index if not exists company_proposals_contract on company_proposals(contract_id) where contract_id is not null;
create index if not exists company_proposals_pending_admin on company_proposals(state, created_at) where state = 'admin_review';
