-- migrations/027-helper-action-chime-cooldown.sql
--
-- 1. SCHEMA CHANGE
-- Adds helper_rep_state.last_action_chime_at (timestamptz, nullable).
-- Used as a per-rep 5-min cooldown gate for the new
-- /api/help/chime-in/check action-triggered chime path (Dream #1).
--
-- 2. WHO WRITES THIS?
-- src/app/api/help/chime-in/check/route.ts — only when an actual
-- chime fires (not on silent skips), so a wave of skipped probes
-- doesn't burn the cooldown budget for the next real chime.
--
-- 3. WHO READS THIS?
-- Same route. On the next probe within COOLDOWN_MS (5 min) of
-- last_action_chime_at, the route returns chime: null with reason
-- "cooldown" without invoking the LLM.
--
-- 4. BACKFILL FOR OLD ROWS
-- (c) intentionally NULL forever for legacy rows. Semantics: NULL =
-- "no chime ever fired for this rep" = cooldown not active = next
-- probe is allowed. That's the desired behavior for existing rows.
-- No backfill needed.
--
-- Reference: docs/DATA_INTEGRITY_PLAN.md Tier 4

alter table helper_rep_state
  add column if not exists last_action_chime_at timestamptz;

notify pgrst, 'reload schema';
