-- migrations/097-template-rep-approval-stage.sql
--
-- 1. SCHEMA CHANGE
-- Three new columns on email_templates for the rep-approval stage of
-- the auto-template flow (docs/superpowers/plans/2026-05-16-auto-
-- template-propose-to-rep.md).
--
--   proposed_to_rep_at  timestamptz — when Leon DMed the rep with the
--                                     proposal card. NULL = not yet sent.
--   rep_approved_at     timestamptz — when the rep clicked ✓ on Leon's
--                                     card. NULL = rep hasn't approved.
--                                     Gates the admin-card fire.
--   rep_rejection_reason text       — set when rep clicks ❌ or replies
--                                     with revision feedback. Becomes
--                                     evidence for next clustering run.
--
-- 2. WHO WRITES?
-- - proposed_to_rep_at: cron /api/cron/propose-templates-to-reps after
--   successful Lark card send.
-- - rep_approved_at: rep-template-card.ts:processRepTemplateCardAction
--   on ✓ button click.
-- - rep_rejection_reason: same handler on ❌ click, or via the
--   /api/templates/[id]/rep-revise multi-turn endpoint.
--
-- 3. WHO READS?
-- - admin-approval-cards.ts:sendTemplateProposalCard — guards: refuses
--   to fire admin card unless rep_approved_at IS NOT NULL.
-- - The propose-to-reps cron — to find candidates (NULL =
--   needs-sending) and to re-nudge stale rows (>72h, <7d).
--
-- 4. BACKFILL
-- Existing rows: leave all three columns NULL. Rows currently
-- status='proposal' WITHOUT rep_id (org-wide congress proposals) stay
-- in the admin-only flow — the new cron skips them by filtering on
-- rep_id IS NOT NULL.

ALTER TABLE email_templates
  ADD COLUMN IF NOT EXISTS proposed_to_rep_at timestamptz,
  ADD COLUMN IF NOT EXISTS rep_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS rep_rejection_reason text;

-- Index: the cron's primary query is "status='proposal' AND rep_id
-- IS NOT NULL AND proposed_to_rep_at IS NULL". A partial index keeps
-- the working set tiny.
CREATE INDEX IF NOT EXISTS email_templates_pending_rep_propose_idx
  ON email_templates (rep_id, created_at)
  WHERE status = 'proposal' AND rep_id IS NOT NULL AND proposed_to_rep_at IS NULL;
