-- Migration 088: dynamic_tools — Leon-authored SQL tools
--
-- 1. SCHEMA CHANGE
--   New table for tools Leon proposes mid-session. Each row is a
--   parameterized SELECT statement Leon believes it would benefit from.
--   Admin reviews via Lark card (Yes/No). Approved tools are callable
--   from the same agent loop as built-in tools, no deploy required.
--
-- 2. WHO WRITES
--   - propose_tool (in helper-read-tools.ts) inserts pending rows.
--   - The admin_inbox card click flow flips status pending→approved/rejected.
--   - Sysadmin can hard-delete via SQL if a tool turns out wrong.
--
-- 3. WHO READS
--   - runReadTool falls through to dynamic_tools when the call.tool name
--     isn't in the static dispatcher.
--   - /admin/dynamic-tools dashboard lists pending+approved tools.
--
-- 4. BACKFILL
--   - None. Forward-only.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS dynamic_tools (
  id              uuid primary key default gen_random_uuid(),
  name            text not null unique,          -- snake_case, must not collide with built-ins
  description     text not null,                 -- what the tool does, in 1-2 sentences
  args_schema     jsonb not null default '{}',   -- { argName: { type, default?, description? } }
  sql_template    text not null,                 -- parameterized SELECT with $1, $2, etc.
  param_order     text[] not null default '{}',  -- arg names in the order they map to $1, $2

  status          text not null default 'pending'
                  check (status in ('pending', 'approved', 'rejected', 'deprecated')),
  proposed_by_rep_id  integer null references sales_reps(id) on delete set null,
  proposed_at         timestamptz not null default now(),
  proposal_reason     text,                       -- why Leon thought this tool would help

  approved_by_rep_id  integer null references sales_reps(id) on delete set null,
  approved_at         timestamptz null,
  approval_note       text,

  rejected_reason     text,
  rejected_at         timestamptz null,

  -- Usage tracking — surface on the dashboard so admin can spot dead tools
  call_count          integer not null default 0,
  last_called_at      timestamptz,
  last_error          text,                       -- last execution error, for debugging

  -- Link to the admin_inbox row that surfaced the proposal
  inbox_id            uuid null references admin_inbox(id) on delete set null
);

CREATE INDEX IF NOT EXISTS idx_dynamic_tools_status
  ON dynamic_tools (status, proposed_at DESC);
CREATE INDEX IF NOT EXISTS idx_dynamic_tools_approved
  ON dynamic_tools (name)
  WHERE status = 'approved';

NOTIFY pgrst, 'reload schema';
