-- Migration 089: admin_inbox reasons + Yes/No/More-context redesign
--
-- 1. SCHEMA CHANGE
--   - admin_inbox gets two new columns: rejected_reason (text the admin
--     wrote when saying No) + awaiting_reason_since (timestamp when
--     admin clicked No, waiting for them to type why).
--   - Status check constraint extended to include 'awaiting_reason'.
--
-- 2. WHO WRITES
--   - admin-inbox-card.ts: flips status to 'awaiting_reason' on No click,
--     sets awaiting_reason_since=now()
--   - lark-agent.ts: when admin DMs Leon within 10 min after a No click,
--     the message text is saved as rejected_reason and status flips to
--     'dismissed'
--
-- 3. WHO READS
--   - /admin/inbox dashboard shows rejected_reason next to dismissed rows
--   - Future: a miner that clusters rejected_reasons to surface "admin
--     keeps rejecting X kind of suggestion" patterns
--
-- 4. BACKFILL
--   - None. New rows fill forward. Old dismissed rows simply have null
--     rejected_reason which the UI handles fine.
--
-- Idempotent.

ALTER TABLE admin_inbox
  ADD COLUMN IF NOT EXISTS rejected_reason text,
  ADD COLUMN IF NOT EXISTS awaiting_reason_since timestamptz;

-- Extend the status check to allow 'awaiting_reason'. PG doesn't let us
-- edit a CHECK in place; we drop & re-add.
ALTER TABLE admin_inbox DROP CONSTRAINT IF EXISTS admin_inbox_status_check;
ALTER TABLE admin_inbox
  ADD CONSTRAINT admin_inbox_status_check
  CHECK (status IN ('new', 'acknowledged', 'dismissed', 'done', 'awaiting_reason'));

CREATE INDEX IF NOT EXISTS admin_inbox_awaiting_idx
  ON admin_inbox(awaiting_reason_since DESC)
  WHERE status = 'awaiting_reason';

NOTIFY pgrst, 'reload schema';
