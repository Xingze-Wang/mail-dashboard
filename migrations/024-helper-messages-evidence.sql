-- Migration 024: helper_messages.evidence — store structured citation
-- payloads alongside the assistant text.
--
-- Background: helper answers now emit evidence blocks (see
-- /Users/xingzewang/Desktop/mail/src/lib/helper-evidence.ts) that the
-- UI renders as expandable "show the data" cards. Persisting them on
-- the message lets the cards re-render on chat-history reload, not
-- just on the live response.
--
-- Idempotent. Nullable JSONB — old messages stay untouched.

BEGIN;

ALTER TABLE helper_messages
  ADD COLUMN IF NOT EXISTS evidence jsonb;

NOTIFY pgrst, 'reload schema';

COMMIT;
