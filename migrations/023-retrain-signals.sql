-- Migration 023: retrain_signals — events that hint a model retrain
-- might improve outcomes.
--
-- Populated by:
--   - cron when new wechat conversions cross a threshold
--   - cron when scorer's calibration drift exceeds a threshold
--   - rep flags (lead_corrections of severity='hard')
--   - drift miner finding new accepted patterns
--
-- Read by the weekly proposal job which summarizes pending signals,
-- decides whether retrain is justified, and either auto-runs or files
-- a proposal for admin review.
--
-- Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS retrain_signals (
  id           uuid primary key default gen_random_uuid(),
  signal_kind  text not null,            -- 'new_wechat' | 'calibration_drift' | 'rep_correction' | 'drift_pattern'
  payload      jsonb,                    -- structured details (counts, deltas, IDs)
  weight       double precision default 1.0,
  -- Lifecycle: pending → consumed (by a retrain) | dismissed (admin said no)
  status       text not null default 'pending',
  created_at   timestamptz default now(),
  consumed_at  timestamptz,
  consumed_by  text                      -- 'auto' | 'admin' | retrain run id
);

CREATE INDEX IF NOT EXISTS idx_retrain_signals_pending ON retrain_signals (created_at DESC) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS retrain_proposals (
  id            uuid primary key default gen_random_uuid(),
  rationale     text not null,           -- LLM- or rule-generated one-paragraph reason
  signal_count  int not null,
  signal_ids    uuid[] not null,
  status        text not null default 'pending',  -- 'pending' | 'approved' | 'rejected' | 'expired'
  decided_by    text,
  decided_at    timestamptz,
  created_at    timestamptz default now()
);

CREATE INDEX IF NOT EXISTS idx_retrain_proposals_pending ON retrain_proposals (created_at DESC) WHERE status = 'pending';

NOTIFY pgrst, 'reload schema';

COMMIT;
