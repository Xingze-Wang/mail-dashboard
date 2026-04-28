-- migrations/031-helper-predictions-judge.sql
--
-- 1. SCHEMA CHANGE
-- Adds judge columns to helper_predictions, mirroring the shape used
-- on pipeline_leads (migration 008): judge_avg real, judge_at
-- timestamptz, judge_verdicts jsonb. Lets the prediction resolver
-- run the 3-judge ensemble on each prediction at resolution time so
-- the helper can learn from "wrong outcome but right reasoning" vs
-- "right outcome but lazy reasoning" — not just binary correct/wrong.
--
-- 2. WHO WRITES THIS?
-- src/lib/predictions.ts resolveDuePredictions() — when each due
-- prediction resolves, calls judgePrediction() and writes the avg +
-- per-judge verdicts into the same row. Self-critique strength is
-- modulated by judge_avg: low-score wrong → strong critique; high-
-- score wrong → soft (world surprised me); low-score right → "right
-- by accident, lower confidence."
--
-- 3. WHO READS THIS?
-- (a) /api/help/predictions/recent — admin tile already returns
--     accuracy summary; will surface judge_avg histogram alongside.
-- (b) Future: /drift Judge-vs-Human tab gets a "Helper predictions"
--     panel that joins outcome × judge to show 4 quadrants.
--
-- 4. BACKFILL FOR OLD ROWS
-- (c) intentionally NULL forever for legacy rows. The helper_predictions
--     table just landed in migration 029; any existing rows are smoke-
--     test data with no useful claim+outcome pair to judge. New rows
--     get judged at resolution time.
--
-- Reference: docs/DATA_INTEGRITY_PLAN.md Tier 4

alter table helper_predictions
  add column if not exists judge_avg      real,
  add column if not exists judge_at       timestamptz,
  add column if not exists judge_verdicts jsonb;

create index if not exists idx_helper_pred_judge_avg
  on helper_predictions (judge_avg)
  where judge_avg is not null;

notify pgrst, 'reload schema';
