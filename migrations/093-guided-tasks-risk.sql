-- Migration 093: per-step risk level + admin notes for guided_tasks
--
-- Extend the existing guided_tasks `steps` shape (jsonb[]) so each step
-- carries a risk_level. We don't reshape steps at the DB level (still
-- jsonb), but the planner now writes:
--   { intent, verification?, risk_level: 'auto'|'review' }
-- and the engine reads risk_level to decide auto-continue vs wait-for-ack.
--
-- Two new table columns:
--   awaiting_step_ack — the step index that's currently paused waiting
--     for explicit admin approval (null if no pause). Lets the UI know
--     where to render the action buttons.
--   admin_notes — array of {step_index, text} entries written by admin
--     when they want to leave a correction hint before approving.
--
-- Idempotent.

ALTER TABLE guided_tasks
  ADD COLUMN IF NOT EXISTS awaiting_step_ack integer,
  ADD COLUMN IF NOT EXISTS admin_notes jsonb NOT NULL DEFAULT '[]'::jsonb;

NOTIFY pgrst, 'reload schema';
