-- 075-insights-snapshots.sql
-- ════════════════════════════════════════════════════════════════════
-- 1. SCHEMA CHANGE
-- New table insights_snapshots: daily-stable cached cuts of the
-- /analysis/cut/* surface. The page reads from here so loads are
-- instant; a daily LLM cron decides whether the current day's
-- compute warrants a "realign" (publishing a new snapshot) or
-- whether yesterday's view is still accurate.
--
-- Pattern: cron-as-gatekeeper. Same principle as the Wilson CI gate
-- in the auto-promote cron — don't redraw the page unless the data
-- movement is meaningful. Users get a stable mental model: they see
-- the same numbers all day, can reference them in conversations.
-- The realignment banner is the announcement when reality shifted.
--
-- Each row is one (dimension, date, scope) snapshot. Scope is
-- (rep_id, lookback_days) so a per-rep view can have its own
-- snapshot independently from the org-wide view. Most queries are
-- org-wide (rep_id IS NULL), but per-rep is the existing pattern
-- on /analysis.
--
-- Realignment is captured on the new snapshot row:
--   - prev_snapshot_id: pointer to whichever snapshot this replaces
--   - realignment_reason: short LLM-authored explanation (~1 sentence)
--     shown in the page banner. Null when the realign is automatic /
--     scheduled (every Monday, say) without specific rationale.
--   - movement_summary: structured diff jsonb (per-segment delta) —
--     the data the banner pulls "Previous: A%, This week: B%" from.
--
-- 2. WHO WRITES
--   - GET /api/cron/insights-realign (daily ~06:00 UTC) — the LLM
--     gatekeeper. Computes today's fresh insight, compares to
--     yesterday's published snapshot, asks the LLM to decide
--     "realign or stay", and either inserts a new row (realign) or
--     does nothing (stay).
--   - POST /api/admin/insights/realign-now (admin manual override)
--
-- 3. WHO READS
--   - GET /api/analysis/cut/:dim — instant read from this table,
--     no live compute. Falls back to live compute only if no
--     snapshot exists yet (bootstrapping).
--
-- 4. BACKFILL
--   Empty at start. The cron's first run will compute today's data
--   for each (dim, scope=org-wide) pair and insert with
--   realignment_reason='initial bootstrap'. Subsequent days run the
--   compare-and-decide loop.

CREATE TABLE IF NOT EXISTS insights_snapshots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Which cut. Matches the KNOWN_DIMS keys in /api/analysis/cut/route.ts:
  -- geo_binary, geo_detail, school_tier, lead_tier, h_index, citations,
  -- direction, geo_x_school. Free-form text so future dims don't need
  -- a migration; the cron handler validates against the live KNOWN_DIMS.
  dimension       text NOT NULL,

  -- Scoping. NULL rep_id = org-wide (most common). lookback_days
  -- defaults to 90; future versions might support different windows.
  rep_id          int  REFERENCES sales_reps(id),
  lookback_days   int  NOT NULL DEFAULT 90,

  -- The full computed payload — same shape as what
  -- computeSegmentFunnels returns for this dimension. Stored as
  -- JSONB so the API layer just hands it through to the page.
  payload         jsonb NOT NULL,

  -- Realignment context.
  prev_snapshot_id   uuid REFERENCES insights_snapshots(id),
  realignment_reason text,                     -- LLM 1-sentence why
  movement_summary   jsonb,                    -- structured diff for banner
  decided_by         text NOT NULL DEFAULT 'cron'
                     CHECK (decided_by IN ('cron', 'admin', 'bootstrap')),

  -- Bookkeeping
  computed_at     timestamptz NOT NULL DEFAULT now(),
  -- The day this snapshot is "for" — what users see on this date.
  effective_date  date NOT NULL DEFAULT CURRENT_DATE,
  -- Which model decided (for telemetry / picking up improvements).
  decision_model  text
);

-- One active snapshot per (dim, scope, day). Subsequent realigns on
-- the same day overwrite — admins can iterate without DB cleanup.
CREATE UNIQUE INDEX IF NOT EXISTS insights_snapshots_unique
  ON insights_snapshots (dimension, COALESCE(rep_id, 0), lookback_days, effective_date);

-- Hot path: page asks for the snapshot for "today, this dim, org-wide".
CREATE INDEX IF NOT EXISTS insights_snapshots_lookup
  ON insights_snapshots (dimension, rep_id, lookback_days, effective_date DESC);
