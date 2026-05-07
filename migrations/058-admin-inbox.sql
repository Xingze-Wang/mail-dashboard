-- migrations/058-admin-inbox.sql
--
-- 1. SCHEMA CHANGE
-- One new table: admin_inbox. The "Leon writes notes for admin" channel.
-- Distinct from get_admin_alerts (derived from queries) and lark_messages
-- (raw chat history). This is a structured queue where Leon (the LLM)
-- explicitly records something he thinks the admin should know or do.
--
-- Columns:
--   id            uuid PK
--   kind          text — 'request' (admin should DO something) |
--                        'observation' (admin should KNOW something) |
--                        'idea' (Leon proposes a thing to consider)
--   headline      text — one-line summary, shown in lists
--   body          text — full context (multi-paragraph)
--   source_rep_id int  — which rep's conversation surfaced this (NULL ok)
--   evidence      jsonb — links / lead_ids / message snippets backing
--                        the observation. Optional.
--   status        text — 'new' | 'acknowledged' | 'dismissed' | 'done'
--   dedup_hash    text — sha256 of (kind|headline|source_rep_id) so
--                        repeat insights become updates instead of dupes
--   created_at    timestamptz
--   updated_at    timestamptz
--   acted_at      timestamptz — when admin marked acknowledged/done/dismissed
--
-- 2. WHO WRITES THIS?
-- src/lib/helper-read-tools.ts (the dispatcher) — Leon emits a
-- record_admin_request tool call from his LLM turn. Idempotent via
-- dedup_hash: if a row with the same hash exists, we update it
-- (refresh body/evidence, keep the existing status).
--
-- 3. WHO READS THIS?
-- Three readers, all already exist or are trivial:
--   - list_admin_inbox helper-tool (admin asks Leon "what have you
--     been noticing"). Filters by status, defaults to 'new' only.
--   - Optional future /admin/inbox dashboard page (out of scope this PR).
--   - get_admin_alerts (existing tool) — extended to surface the
--     count of new admin_inbox entries as one of its alert kinds.
--
-- 4. BACKFILL FOR OLD ROWS
-- (d) Not applicable — new table, starts empty.

CREATE TABLE IF NOT EXISTS admin_inbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('request', 'observation', 'idea')),
  headline        text NOT NULL,
  body            text,
  source_rep_id   int REFERENCES sales_reps(id),
  evidence        jsonb,
  status          text NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new', 'acknowledged', 'dismissed', 'done')),
  dedup_hash      text NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  acted_at        timestamptz
);

CREATE INDEX IF NOT EXISTS admin_inbox_status_idx
  ON admin_inbox(status, created_at DESC)
  WHERE status = 'new';

CREATE INDEX IF NOT EXISTS admin_inbox_source_rep_idx
  ON admin_inbox(source_rep_id)
  WHERE source_rep_id IS NOT NULL;
