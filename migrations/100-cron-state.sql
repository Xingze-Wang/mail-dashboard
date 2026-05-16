-- migrations/100-cron-state.sql
--
-- 1. SCHEMA CHANGE
-- New table `cron_state` — a tiny key/value scratchpad for cron jobs
-- that need to remember where they left off between invocations.
-- One row per cron, keyed on `cron_name` (text PK).
--
-- Columns:
--   cron_name    text PRIMARY KEY — short ID, e.g. 'mp_backfill'.
--   cursor       bigint          — integer cursor a job uses to resume.
--                                  Semantics owned by the job (e.g. an
--                                  offset into a sorted email list).
--   last_run_at  timestamptz     — when the job most recently ran.
--   last_completed_at timestamptz — when it most recently completed a
--                                  full pass (cursor wrapped to 0).
--   meta         jsonb            — optional per-cron metadata (errors,
--                                  rates, last-batch stats). NULL OK.
--
-- 2. WHO WRITES?
-- Each cron route that opts in. Initial writer:
--   src/app/api/cron/sync-miracleplus-backfill/route.ts — updates
--   cursor + last_run_at on every invocation, and last_completed_at
--   when the cursor wraps to 0.
--
-- 3. WHO READS?
-- Same routes (to resume). Optionally exposed via admin debug pages
-- ("when did cron X last complete a full pass") but no UI surface
-- depends on this today.
--
-- 4. BACKFILL FOR OLD ROWS
-- (d) Not applicable — new table, no historical concept of "cron
--     state" before now. First invocation of each cron lazily inserts
--     its row with cursor=0.

CREATE TABLE IF NOT EXISTS cron_state (
  cron_name          text PRIMARY KEY,
  cursor             bigint NOT NULL DEFAULT 0,
  last_run_at        timestamptz,
  last_completed_at  timestamptz,
  meta               jsonb
);
