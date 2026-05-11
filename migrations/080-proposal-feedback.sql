-- 080-proposal-feedback.sql
-- ════════════════════════════════════════════════════════════════════
-- 1. SCHEMA CHANGE
--
-- proposal_feedback: admin's inline feedback on a congress proposal,
-- delivered through the new /congress/proposals/[id]/review surface.
-- Each row is one comment on one template_proposal. When admin asks
-- congress to revise, the revise endpoint creates a new congress_runs
-- row and stamps revision_run_id here so we have a paper trail of
-- which feedback round produced which proposal version.
--
-- Distinct from email_templates.rejection_reason (mig 076), which is
-- the terminal NO. proposal_feedback is the iterative push-back loop:
-- "this is close but tone is too aggressive — revise."
--
-- 2. WHO WRITES
--   - POST /api/congress/proposals/[id]/review/feedback — admin
--     leaves a comment. Optionally triggers a revise run.
--   - The revise runner stamps revision_run_id once the run is queued.
--
-- 3. WHO READS
--   - GET /api/congress/proposals/[id]/review — full thread of
--     prior feedback rendered alongside the proposal body.
--   - Next weekly buildWeeklyEvidence can pull these as additional
--     evidence so the next congress sees what admin pushed back on.
--
-- 4. BACKFILL
--   Empty at start. The first comment on any proposal creates the
--   first row.
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS proposal_feedback (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The email_templates row this feedback is about. ON DELETE CASCADE
  -- because if the proposal is hard-deleted (rare — usually archived),
  -- the feedback has no anchor.
  template_proposal_id  uuid NOT NULL REFERENCES email_templates(id) ON DELETE CASCADE,
  -- Who left the feedback. NULL only allowed transitionally; in
  -- practice every comment has an author.
  author_rep_id         int REFERENCES sales_reps(id),
  -- The comment text. Min 10 chars enforced at the API layer for the
  -- same reason as rejection_reason — short comments aren't useful
  -- evidence for the synthesizer.
  body                  text NOT NULL,
  -- Optional pointer at the revise run this feedback triggered.
  -- NULL = feedback was a comment but didn't trigger a revise.
  revision_run_id       uuid REFERENCES congress_runs(id) ON DELETE SET NULL,
  -- Bookkeeping.
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- Hot path: page loads "give me all feedback on this proposal,
-- oldest first" — so we can render a thread.
CREATE INDEX IF NOT EXISTS proposal_feedback_thread
  ON proposal_feedback (template_proposal_id, created_at ASC);
