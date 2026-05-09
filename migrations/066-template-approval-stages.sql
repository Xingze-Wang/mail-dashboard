-- 066-template-approval-stages.sql
-- ════════════════════════════════════════════════════════════════════
-- 1. SCHEMA CHANGE
-- Splits the proposal → active flip into TWO stages:
--   proposal       — congress / admin draft, NOT in any production
--                    flow. Visible on bench, inspector. Default for
--                    new rows from congress-hypothesis runner.
--   approved_draft — admin reviewed the prose and signed off ("the
--                    text reads OK"). Still NOT routing real traffic.
--                    loadEffectiveTemplate ignores. Bench shows green
--                    badge.
--   active         — admin ALSO approved the routing rule (segment
--                    assignment). Production traffic flows through.
--                    loadEffectiveTemplate matches.
--   archived       — superseded; never in flow.
--
-- This is the user's "two approvals" pattern: confirm draft, confirm
-- route, separately. Avoids accidentally routing traffic through a
-- template the admin only meant to read.
--
-- 2. WHO WRITES?
-- - status='proposal'        — congress runner, manual drafts
-- - status='approved_draft'  — POST /api/templates/[id]/approve-draft
--                              (single admin click on bench)
-- - status='active'          — POST /api/templates/[id]/activate
--                              (separate click; requires status was
--                              'approved_draft' OR currently 'active')
-- - status='archived'        — admin manually, or auto when a newer
--                              template is activated for the same segment
--
-- 3. WHO READS?
-- - src/lib/template-assembler.ts:loadEffectiveTemplate filters
--   status='active' (this filter already exists; the new
--   'approved_draft' status flows through this filter as NOT-MATCHING,
--   so it's invisible to production).
-- - Bench / inspector: show all non-archived statuses with badges.
--
-- 4. BACKFILL
-- Existing rows: 'proposal' stays 'proposal'; 'active' stays 'active'.
-- The 'global' template is currently 'active' — that's correct: it
-- IS routing production traffic and was implicitly admin-approved by
-- being the only thing.
-- Constraint enforces the new 4-state enum.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'email_templates_status_check'
  ) THEN
    ALTER TABLE email_templates
      DROP CONSTRAINT email_templates_status_check;
  END IF;
  ALTER TABLE email_templates
    ADD CONSTRAINT email_templates_status_check
    CHECK (status IN ('active', 'approved_draft', 'proposal', 'archived'));
END $$;

-- Index for finding "drafts admin already approved but hasn't routed
-- yet" — these are what the templates UI surfaces as "ready to ship".
CREATE INDEX IF NOT EXISTS email_templates_approved_draft_idx
  ON email_templates (created_at DESC)
  WHERE status = 'approved_draft';
