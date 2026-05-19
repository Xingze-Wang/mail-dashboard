-- migrations/101-agent-scheduled-actions.sql
--
-- 1. SCHEMA CHANGE
-- New table `agent_scheduled_actions` — Leon (helper agent) can write
-- scheduled tasks here in-conversation. A new Vercel cron job
-- /api/cron/agent-scheduler runs every 5 minutes, scans for rows with
-- next_fire_at <= now() AND status='active', fires them, and updates
-- next_fire_at using cron_expr. Three action kinds supported in v1:
--   dm_user      — send a Lark DM to target_rep_id with payload.message
--   call_tool    — call any Leon read-tool (payload.tool_name + args)
--                  and write result into admin_inbox + DM caller
--   call_workflow — fire a named workflow (payload.workflow_name)
--                  these are hardcoded in src/lib/agent-scheduler.ts;
--                  v1 ships with one ("scan_stale_wechat_dm_owners")
--
-- Columns:
--   id              uuid PK
--   created_by      int FK sales_reps — who scheduled this
--   target_rep_id   int FK sales_reps (nullable for workflow kind)
--   kind            text — "dm_user" | "call_tool" | "call_workflow"
--   cron_expr       text — 5-field standard cron, e.g. "0 17 * * 5"
--                          (UTC; the agent translates Beijing time)
--   payload         jsonb — kind-specific args
--   next_fire_at    timestamptz NOT NULL — scheduler's worklist key
--   last_fire_at    timestamptz
--   fire_count      int default 0
--   last_error      text — for debugging
--   status          text — "active" | "paused" | "done" | "errored"
--   description     text — agent's free-text summary for admin review
--   admin_approved  bool default false — Yes/No on the Lark card
--                                         must be true before first fire
--   created_at      timestamptz default now()
--   updated_at      timestamptz default now()
--
-- 2. WHO WRITES?
-- src/lib/helper-tools.ts → schedule_action tool (inserts pending row,
--   admin_approved=false, pushes Lark Yes/No card via admin_inbox).
-- src/app/api/cron/agent-scheduler/route.ts (updates last_fire_at,
--   fire_count, next_fire_at after each fire; sets status='errored'
--   with last_error if fire fails).
-- Admin via admin_inbox Yes button → flips admin_approved=true.
--
-- 3. WHO READS?
-- /api/cron/agent-scheduler (worklist). Possible future admin UI
-- showing "scheduled jobs Leon set up" — no UI today.
--
-- 4. BACKFILL FOR OLD ROWS
-- (d) Not applicable — new table.

CREATE TABLE IF NOT EXISTS agent_scheduled_actions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by      int  NOT NULL REFERENCES sales_reps(id) ON DELETE CASCADE,
  target_rep_id   int  REFERENCES sales_reps(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('dm_user', 'call_tool', 'call_workflow')),
  cron_expr       text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  next_fire_at    timestamptz NOT NULL,
  last_fire_at    timestamptz,
  fire_count      int  NOT NULL DEFAULT 0,
  last_error      text,
  status          text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'done', 'errored')),
  description     text,
  admin_approved  bool NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Worklist index: scheduler scans active+approved rows due to fire.
CREATE INDEX IF NOT EXISTS agent_scheduled_actions_due_idx
  ON agent_scheduled_actions (next_fire_at)
  WHERE status = 'active' AND admin_approved = true;

-- Per-creator lookup for "show me my scheduled jobs"
CREATE INDEX IF NOT EXISTS agent_scheduled_actions_creator_idx
  ON agent_scheduled_actions (created_by, created_at DESC);
