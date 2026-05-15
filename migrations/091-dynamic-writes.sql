-- Migration 091: Leon-proposed DB writes (with admin approval)
--
-- 1. SCHEMA CHANGE
--   - dynamic_writes: parallel to dynamic_tools but for DML
--     (INSERT/UPDATE/DELETE). Leon proposes parameterized SQL; admin
--     approves via Lark card; the SQL runs and gets logged.
--   - db_write_log: immutable audit of every write (auto + approved).
--   - _run_write_sql RPC: the sandbox boundary — whitelists table
--     names, blocks blacklisted tables, refuses DDL, enforces single
--     statement, statement_timeout, parameterized args.
--
-- 2. WHO WRITES
--   - dynamic_writes: proposeDynamicWrite (helper-read-tools.ts) inserts
--     pending rows. Admin's Lark Yes click flips to approved + runs SQL.
--   - db_write_log: every successful _run_write_sql call appends one row.
--
-- 3. WHO READS
--   - /admin/db-writes dashboard (TBD)
--   - Daily-digest cron pulls last-24h rows from db_write_log
--   - audit replays
--
-- 4. BACKFILL
--   - None. Forward-only.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS dynamic_writes (
  id                  uuid primary key default gen_random_uuid(),
  name                text,                       -- optional short label, not unique
  description         text not null,              -- what this write does, 1-2 sentences
  sql_template        text not null,              -- parameterized DML, single statement
  param_values        jsonb not null default '[]'::jsonb,  -- the literal values for $1..$N at exec time
  proposal_reason     text,                       -- why Leon thinks this write is needed
  target_table        text,                       -- the primary table being written (for filtering / logging)

  status              text not null default 'pending'
                      check (status in ('pending', 'approved', 'rejected', 'applied', 'apply_failed')),
  proposed_by_rep_id  integer null references sales_reps(id) on delete set null,
  proposed_at         timestamptz not null default now(),

  approved_by_rep_id  integer null references sales_reps(id) on delete set null,
  approved_at         timestamptz null,
  approval_note       text,

  rejected_reason     text,
  rejected_at         timestamptz null,

  applied_at          timestamptz null,
  apply_result        jsonb,                      -- whatever _run_write_sql returns
  apply_error         text,

  inbox_id            uuid null references admin_inbox(id) on delete set null
);

CREATE INDEX IF NOT EXISTS idx_dynamic_writes_status
  ON dynamic_writes (status, proposed_at DESC);

-- Immutable audit log. INSERT-only by convention; no UPDATE/DELETE
-- (those would be the kind of thing Leon should never do).
CREATE TABLE IF NOT EXISTS db_write_log (
  id              uuid primary key default gen_random_uuid(),
  source          text not null,                  -- 'auto' | 'approved_proposal' | 'admin_self'
  source_rep_id   integer null references sales_reps(id) on delete set null,
  proposal_id     uuid null references dynamic_writes(id) on delete set null,
  table_name      text,
  sql_text        text not null,
  param_values    jsonb,
  rows_affected   integer,
  ok              boolean not null,
  error           text,
  ran_at          timestamptz not null default now()
);

CREATE INDEX IF NOT EXISTS idx_db_write_log_ran_at
  ON db_write_log (ran_at DESC);
CREATE INDEX IF NOT EXISTS idx_db_write_log_source
  ON db_write_log (source, ran_at DESC);

NOTIFY pgrst, 'reload schema';
