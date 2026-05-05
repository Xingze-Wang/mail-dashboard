-- migrations/048-model-calibration-runs.sql
-- 1. SCHEMA CHANGE
-- model_calibration_runs persists every calibration tick so we can render
-- model-quality drift over time. Each row = one model's score on one
-- run; one calibration sweep produces N rows (one per model in the
-- comma-separated request).
--
-- 2. WHO WRITES   /api/scorer/model-calibration POST path (next iteration)
-- 3. WHO READS    /scorer/calibration drift chart
-- 4. BACKFILL     none — table is empty until first persisted run

create table if not exists model_calibration_runs (
  id uuid primary key default gen_random_uuid(),
  model text not null,
  -- Sample size at the time of the run.
  n integer not null,
  click_accuracy numeric(5,4) not null,
  wechat_accuracy numeric(5,4) not null,
  click_brier numeric(6,4) not null,
  wechat_brier numeric(6,4) not null,
  click_log_loss numeric(6,4) not null,
  wechat_log_loss numeric(6,4) not null,
  avg_latency_s numeric(6,2) not null,
  errors integer not null default 0,
  -- Free-form metadata: lookback window, model batch id, etc.
  meta jsonb not null default '{}',
  run_at timestamptz not null default now()
);

create index if not exists model_calibration_runs_model_time
  on model_calibration_runs(model, run_at desc);
create index if not exists model_calibration_runs_time
  on model_calibration_runs(run_at desc);
