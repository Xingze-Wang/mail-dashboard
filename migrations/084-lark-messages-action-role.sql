-- migrations/084-lark-messages-action-role.sql
--
-- 1. SCHEMA CHANGE
-- Relax lark_messages.role CHECK constraint to accept 'action' and 'system'
-- in addition to existing 'user' | 'assistant'. Used by lark-agent.ts to
-- log every action-tool fire as an audit row, and by /api/cron/standup
-- to mark its outbound messages with role='system' (so they don't pollute
-- conversation history when Leon re-reads context for follow-up DMs).
--
-- 2. WHO WRITES THIS?
-- 'action': src/lib/lark-agent.ts after each successful action-tool dispatch
-- 'system': src/app/api/cron/standup/route.ts after sending the standup DM
--
-- 3. WHO READS THIS?
-- 'action' rows: Leon's get_recent_admin_actions tool reads them when admin
--                asks "what did you do today"
-- 'system' rows: Excluded from conversation-history loading in lark-agent
--
-- 4. BACKFILL FOR OLD ROWS
-- (d) not applicable — only future rows use the new values

ALTER TABLE lark_messages DROP CONSTRAINT IF EXISTS lark_messages_role_check;
ALTER TABLE lark_messages ADD CONSTRAINT lark_messages_role_check
  CHECK (role IN ('user', 'assistant', 'action', 'system'));
