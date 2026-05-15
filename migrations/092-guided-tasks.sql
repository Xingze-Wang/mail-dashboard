-- Migration 092: guided_tasks — multi-step plans with admin checkpoints
--
-- 1. SCHEMA CHANGE
--   guided_tasks: a task Leon and admin work through together. Leon
--   proposes a plan (N steps, each with intent + verification idea);
--   admin approves the plan; Leon executes step-by-step, pausing
--   after each for admin to ack/correct/abort.
--
-- 2. WHO WRITES
--   - start_guided_task tool (Leon) inserts a planned row
--   - admin Lark Yes on plan card → status=running, current_step=0
--   - each step completion appends to step_results jsonb[] + bumps
--     current_step; if final step, status=completed
--   - admin can DM 'abort task X' to stop mid-flight (status=aborted)
--
-- 3. WHO READS
--   - get_guided_task tool — admin or Leon can look up state
--   - list_guided_tasks — admin sees in-progress + recently completed
--   - lark-agent.ts checks for in-progress tasks when admin DMs
--
-- 4. BACKFILL
--   - None. Forward-only.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS guided_tasks (
  id              uuid primary key default gen_random_uuid(),
  goal            text not null,                 -- the user-facing description
  constraints     text,                          -- admin-supplied constraints / red lines
  -- Plan: jsonb array of { intent: text, verification?: text }
  -- intent = "I will do X"
  -- verification = optional "I expect to see Y as proof it worked"
  steps           jsonb not null,
  -- Per-step results, indexed parallel to steps. Each entry:
  -- { ok: bool, summary: text, evidence?: any, ran_at: timestamptz, ack?: 'continue'|'modified'|'aborted' }
  step_results    jsonb not null default '[]'::jsonb,

  current_step    integer not null default 0,
  status          text not null default 'planned'
                  check (status in ('planned','running','paused','completed','aborted','failed')),

  proposed_by_rep_id  integer null references sales_reps(id) on delete set null,
  approved_by_rep_id  integer null references sales_reps(id) on delete set null,

  created_at      timestamptz not null default now(),
  approved_at     timestamptz,
  completed_at    timestamptz,
  aborted_at      timestamptz,
  abort_reason    text,

  -- Link to the admin_inbox row for the initial plan-approval card
  inbox_id        uuid null references admin_inbox(id) on delete set null
);

CREATE INDEX IF NOT EXISTS idx_guided_tasks_status
  ON guided_tasks (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_guided_tasks_running
  ON guided_tasks (created_at DESC)
  WHERE status IN ('running', 'paused');

NOTIFY pgrst, 'reload schema';
