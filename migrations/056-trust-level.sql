-- migrations/056-trust-level.sql
--
-- 1. SCHEMA CHANGE
-- Adds three columns to sales_reps for the "training wheels" feature:
--   * trust_level (int, default 0) — admin-managed override. -1 = restricted
--     below default; 0 = baseline (everyone starts here); positive ints
--     boost. lib/trust-level.ts derives capability from the COMBINATION of
--     trust_level and total_sends_count, so admin can either nudge with
--     trust_level OR let total_sends accumulate, or both.
--   * onboarded_at (timestamptz, default now()) — used as a tenure proxy
--     so very-new reps can be detected even before their first send.
--   * trust_notes (text) — admin's freeform note, e.g. "Dani: limit to
--     5/day until she's back from leave". Surfaced on the rep settings
--     page; helper bot can also read this when a rep asks "why am I
--     limited?".
-- total_sends_count is NOT added — we derive it on demand from emails
-- (see lib/trust-level.ts:totalSendsByRep). Materializing would be faster
-- but adds a sync hazard; the query is a count() with an index, so cheap.
--
-- 2. WHO WRITES THIS?
-- - sales_reps.trust_level: only admin via /api/admin/rep-trust (new in
--   this PR). Helper bot delegates to admin when reps ask.
-- - sales_reps.onboarded_at: defaults at sales_reps INSERT (one place in
--   src/lib/onboarding.ts:provisionRep, plus migrations/003 backfill
--   below for existing rows).
-- - sales_reps.trust_notes: admin via the same /api/admin/rep-trust route.
--
-- 3. WHO READS THIS?
-- - src/lib/trust-level.ts: getCapabilities(repId) → returns
--   { canBulkSend, dailyLeadCap, reason }. Called from:
--     * /api/pipeline/batch-send (gates BATCH_MAX per call)
--     * /api/cron (caps how many leads cron drops in /pipeline per day)
--     * /api/admin/rep-trust GET (admin UI shows current state)
--     * helper-tools (when rep asks the bot why limits)
-- - The /pipeline UI calls a small /api/me/trust endpoint to render hints
--   ("3 more sends until bulk unlocks").
--
-- 4. BACKFILL FOR OLD ROWS
-- (a) one-shot UPDATE inline below. Existing reps (Leo / Yujie / Ethan /
-- admins) get onboarded_at = the row's created_at — which is correct,
-- since they all completed the old onboarding-via-SQL-seed manually. They
-- already have plenty of sends; no risk that backfilled tenure flips them
-- into a restricted bucket.

ALTER TABLE sales_reps
  ADD COLUMN IF NOT EXISTS trust_level int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS onboarded_at timestamptz,
  ADD COLUMN IF NOT EXISTS trust_notes text;

-- Backfill existing rows so they have a defined onboarded_at. created_at
-- is the row insert time (close enough — these reps were all seeded via
-- migrations 001-003 and 053, before this trust system existed).
UPDATE sales_reps
SET onboarded_at = created_at
WHERE onboarded_at IS NULL;

-- Index supports the cron's "how many sends today by rep" query that
-- gates dailyLeadCap.
CREATE INDEX IF NOT EXISTS emails_actor_rep_created_idx
  ON emails (actor_rep_id, created_at DESC);
