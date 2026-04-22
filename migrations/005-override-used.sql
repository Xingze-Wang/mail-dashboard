-- ═══════════════════════════════════════════════════════════════════
-- Migration 005: Track 7-day override usage on sends
-- Run in Supabase SQL Editor.
-- ═══════════════════════════════════════════════════════════════════
--
-- Adds `override_used` on pipeline_leads — set to true when a send (single
-- or batch) consumed the per-lead "Override 7-day rule" toggle. Used to
-- enforce a per-rep, per-day cap of 200 overrides without needing a
-- separate counter table: we just COUNT rows where sent_at is in today's
-- Beijing-day window AND override_used is true AND assigned_rep_id = me.
--
-- No backfill needed: historical rows get `false`, which is the correct
-- "we didn't track this yet" value.

ALTER TABLE pipeline_leads
  ADD COLUMN IF NOT EXISTS override_used BOOLEAN NOT NULL DEFAULT false;

-- Partial index tuned for the exact query the send route will run
-- (count today's overrides by rep). Partial because we only care about
-- rows where override_used=true — the vast majority of rows won't match.
CREATE INDEX IF NOT EXISTS idx_pipeline_leads_override_today
  ON pipeline_leads (assigned_rep_id, sent_at)
  WHERE override_used = true;
