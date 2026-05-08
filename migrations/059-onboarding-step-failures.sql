-- migrations/059-onboarding-step-failures.sql
--
-- 1. SCHEMA CHANGE
-- One column added to pending_onboarding: step_failures (int, default 0).
-- Counts how many times the candidate's last message FAILED validation
-- on the current step (e.g., empty name, weak password, invalid email
-- prefix). Reset to 0 every time the step advances. Used by Leon to
-- auto-escalate to admin via admin_inbox + Lark DM after a threshold
-- (2 consecutive failures on the same step) — so a candidate doesn't
-- silently loop on a bad input forever.
--
-- 2. WHO WRITES THIS?
-- src/lib/onboarding.ts — the validation branches in handleCandidateStep.
-- Increment on every failed validation; reset (set to 0) inside the
-- same UPDATE that advances `step` to the next state.
--
-- 3. WHO READS THIS?
-- src/lib/onboarding.ts only — the same file checks step_failures >= 2
-- right after the increment and calls escalateToAdmin(). Not surfaced
-- in any UI or API.
--
-- 4. BACKFILL FOR OLD ROWS
-- (a) DEFAULT 0 fills NULLs — existing pending_onboarding rows (only
-- ever a few at a time, all in active flows) will start at 0 with no
-- ambiguity.

ALTER TABLE pending_onboarding
  ADD COLUMN IF NOT EXISTS step_failures int NOT NULL DEFAULT 0;
