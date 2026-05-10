-- 076-template-rejection-reason.sql
-- ════════════════════════════════════════════════════════════════════
-- 1. SCHEMA CHANGE
-- Adds three columns to email_templates so admin can reject a
-- proposal with an explained reason that future congress runs read
-- as evidence ("don't propose X again — was rejected because Y").
--
--   rejection_reason  text   — the admin's free-form explanation
--   rejected_at       tstz   — when (powers "rejected last 30d" filter)
--   rejected_by_rep_id int   — who said no (audit trail)
--
-- The status flip itself uses the existing 'archived' status (mig
-- 066). This migration just records WHY. Without the reason,
-- congress would re-propose the same kind of change next week —
-- exactly the loop we want to avoid.
--
-- 2. WHO WRITES
--   - POST /api/templates/[id]/reject (admin only) — stamps these
--     three columns + flips status='archived'
--
-- 3. WHO READS
--   - GET /api/templates/library returns rejection_reason so the
--     archived group can show "rejected because: …" in the UI
--   - src/lib/congress-runners.ts buildWeeklyEvidence pulls recent
--     rejections into the evidence pack — synthesizer learns from
--     past 'no's
--   - /admin/template-edits or /templates/[id]/inspect: display
--     reason on archived rows
--
-- 4. BACKFILL
--   No retroactive reasons. Existing 'archived' rows keep null
--   rejection_reason — they predate this feature.

ALTER TABLE email_templates
  ADD COLUMN IF NOT EXISTS rejection_reason   text,
  ADD COLUMN IF NOT EXISTS rejected_at        timestamptz,
  ADD COLUMN IF NOT EXISTS rejected_by_rep_id int REFERENCES sales_reps(id);

-- Hot path: congress evidence pack queries last-30d rejections to
-- feed the synthesizer. Partial index keeps this fast.
CREATE INDEX IF NOT EXISTS email_templates_recent_rejections
  ON email_templates (rejected_at DESC)
  WHERE rejection_reason IS NOT NULL;
