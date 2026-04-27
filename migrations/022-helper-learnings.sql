-- Migration 022: helper_learnings — durable cross-session memory for the
-- sales helper.
--
-- Distinct from `patterns`: those are MEASURED (auto-mined from
-- pipeline_leads + brief_lookups). `helper_learnings` is the helper's
-- own qualitative log — observations it wrote when it noticed
-- something durable about a rep, a customer segment, or itself.
--
-- Three kinds (loose taxonomy, not enforced):
--   rep_pref       — "Mira likes 6-word subjects"
--   tactic         — "opening with a question on .cn leads → 3× reply rate"
--   self_critique  — "I claimed wechat won't work for X, it did. Lower confidence on that pattern."
--
-- Read by /api/help/ask on every turn (filtered to relevant kinds).
-- Written by helper-side tools (suggest_learning) and by the prediction
-- resolver (when surprise events happen).
--
-- Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS helper_learnings (
  id            uuid primary key default gen_random_uuid(),
  scope_rep_id  integer null,                -- null = applies to everyone
  kind          text not null,               -- 'rep_pref' | 'tactic' | 'self_critique' | other
  body          text not null,               -- the actual learning, terse
  evidence      jsonb,                       -- optional structured backing (lead_ids, prediction_id, etc.)
  confidence    double precision default 0.5,
  superseded_at timestamptz,                 -- non-null = no longer active (replaced or invalidated)
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

CREATE INDEX IF NOT EXISTS idx_helper_learnings_scope ON helper_learnings (scope_rep_id, kind) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_helper_learnings_active ON helper_learnings (created_at DESC) WHERE superseded_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'helper_learnings'::regclass AND conname = 'helper_learnings_scope_rep_id_fkey'
  ) THEN
    ALTER TABLE helper_learnings
      ADD CONSTRAINT helper_learnings_scope_rep_id_fkey
      FOREIGN KEY (scope_rep_id) REFERENCES sales_reps(id) ON DELETE CASCADE;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
