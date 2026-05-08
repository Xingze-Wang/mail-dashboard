-- migrations/060-onboarding-followup-stamps.sql
--
-- 1. SCHEMA CHANGE
-- Two columns added to sales_reps for idempotency on the onboarding
-- follow-up cron (api/cron/onboarding-followup):
--   - followup_d1_sent_at  timestamptz  — when the +24h check-in DM was sent
--   - followup_d7_sent_at  timestamptz  — when the +7d retro DM was sent
-- Both NULL by default. Cron fires daily; it picks reps where
-- onboarded_at is in the right window AND the corresponding column
-- is still NULL, then stamps now() so we never double-send.
--
-- 2. WHO WRITES THIS?
-- src/app/api/cron/onboarding-followup/route.ts — sets the column to
-- now() right after the Lark DM resolves (regardless of DM success;
-- a failed DM should not retry forever and re-DM later if Lark recovers
-- — admin can re-DM manually if needed).
--
-- 3. WHO READS THIS?
-- The same cron route — IS NULL filter when picking targets. Optional
-- future read by /admin/inbox dashboard ("reps Leon hasn't followed up
-- with yet"). No other reader.
--
-- 4. BACKFILL FOR OLD ROWS
-- (a) NULL on existing rows is the right semantics — those reps were
-- onboarded before this cron existed, we shouldn't DM them retroactively.
-- The window check (onboarded_at within last ~30h or ~7-7.5d) excludes
-- them naturally too, but the explicit IS NULL guard is defense-in-depth.

ALTER TABLE sales_reps
  ADD COLUMN IF NOT EXISTS followup_d1_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS followup_d7_sent_at timestamptz;
