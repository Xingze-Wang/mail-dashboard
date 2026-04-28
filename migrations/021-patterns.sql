-- Migration 021: patterns table for analysis-driven helper memory.
--
-- Stores notable bucket findings (high lift, sufficient N) so the
-- sales helper can reference current data-driven insights when
-- answering rep questions.
--
-- Refresh policy: wipe-and-rewrite per (scope_rep_id, dimension) on
-- demand. No durable history — patterns are derived data, regenerable
-- from pipeline_leads + brief_lookups any time.
--
-- Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS patterns (
  id            uuid primary key default gen_random_uuid(),
  scope_rep_id  integer null,           -- null = org-wide pattern
  dimension     text not null,          -- e.g. 'direction', 'location', 'compute_level'
  bucket        text not null,          -- the value within that dimension
  sent          int not null,
  wechat        int not null,
  replied       int not null,
  wechat_rate   double precision not null,
  reply_rate    double precision not null,
  wechat_lift   double precision not null,
  reply_lift    double precision not null,
  summary       text not null,
  computed_at   timestamptz not null default now()
);

CREATE INDEX IF NOT EXISTS idx_patterns_scope ON patterns (scope_rep_id, dimension);
CREATE INDEX IF NOT EXISTS idx_patterns_computed ON patterns (computed_at DESC);

-- FK so per-rep patterns get auto-removed when a rep is deleted.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'patterns'::regclass AND conname = 'patterns_scope_rep_id_fkey'
  ) THEN
    ALTER TABLE patterns
      ADD CONSTRAINT patterns_scope_rep_id_fkey
      FOREIGN KEY (scope_rep_id) REFERENCES sales_reps(id) ON DELETE CASCADE;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
