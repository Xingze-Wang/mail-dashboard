-- migrations/102-tool-call-log.sql
--
-- 1. SCHEMA CHANGE
-- New table `tool_call_log` — append-only audit of every tool call the
-- Leon agent makes. Purpose: detect "dumb-ification" (agent calling too
-- many tools per turn, sign of openclaw-style sandboxing). Used by the
-- weekly dumb-check cron (mig 103, separate file) which compares
-- last-7d per-turn-tool-count vs prior 28d baseline.
--
-- Columns:
--   id            uuid PK
--   rep_id        int FK sales_reps — caller (admin or sales)
--   session_id    text — Lark message group / web-helper session
--                        (groups turns within a conversation)
--   turn_index    int — which user-turn-in-this-session this responds to
--                       (1-indexed; lets us compute per-turn aggregates)
--   tool_name     text NOT NULL — e.g. "list_leads", "schedule_action"
--   args_summary  text — truncated json of args (≤500 chars, NO secrets)
--   duration_ms   int — wall time from dispatch to return
--   result_status text — "ok" | "error" | "empty" | "denied"
--   error_class   text — exception class name on error, null otherwise
--   created_at    timestamptz default now()
--
-- 2. WHO WRITES?
-- src/lib/lark-agent.ts → the tool dispatch site (one INSERT after each
-- tool returns, fire-and-forget).
--
-- 3. WHO READS?
-- src/app/api/cron/agent-dumbness-check/route.ts (weekly aggregate).
-- get_tool_usage_stats agent tool (admin-only): admin asks "which tools
-- did I use most this week? which never get called?".
-- Future: dashboards.
--
-- 4. BACKFILL FOR OLD ROWS
-- (d) Not applicable — append-only log starting from this migration.
--     Past tool calls (pre-instrumentation) are unrecoverable. This is
--     OK because dumbness detection is trend-based, not absolute — the
--     first ~4 weeks have no baseline, dumb-check stays silent.

CREATE TABLE IF NOT EXISTS tool_call_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id        int  REFERENCES sales_reps(id) ON DELETE SET NULL,
  session_id    text,
  turn_index    int,
  tool_name     text NOT NULL,
  args_summary  text,
  duration_ms   int,
  result_status text CHECK (result_status IN ('ok', 'error', 'empty', 'denied')),
  error_class   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Trend analysis index: window queries by time
CREATE INDEX IF NOT EXISTS tool_call_log_created_idx
  ON tool_call_log (created_at DESC);

-- Per-rep usage queries
CREATE INDEX IF NOT EXISTS tool_call_log_rep_created_idx
  ON tool_call_log (rep_id, created_at DESC);

-- Per-tool aggregates: "which tool used N times this week"
CREATE INDEX IF NOT EXISTS tool_call_log_tool_idx
  ON tool_call_log (tool_name, created_at DESC);

-- Per-session aggregates: tools-per-turn within one conversation
CREATE INDEX IF NOT EXISTS tool_call_log_session_turn_idx
  ON tool_call_log (session_id, turn_index)
  WHERE session_id IS NOT NULL;
