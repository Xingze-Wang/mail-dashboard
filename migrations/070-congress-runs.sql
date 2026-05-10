-- 070-congress-runs.sql
-- ════════════════════════════════════════════════════════════════════
-- 1. SCHEMA CHANGE
-- Two new tables: congress_runs (the live state of a deliberation,
-- so it can be paused, inspected, and interjected into) and
-- congress_interjections (human comments injected mid-deliberation
-- that the next persona reads as part of the panel context).
--
-- Today congress runs as a single synchronous LLM-batch — all
-- personas speak, then a synthesizer JSON gets persisted. There's
-- no way to interject, and no observable "currently running" state.
--
-- After 070:
--   - Each invocation creates a congress_runs row at status='running'.
--   - The orchestrator advances one persona at a time (so polling +
--     interjection windows exist between personas).
--   - Users can POST to congress_interjections; the next persona's
--     prompt picks them up via "## Daisy 中途插话" running-context
--     section.
--
-- Old synchronous runner stays for back-compat (cron uses it). New
-- stepwise runner is opt-in via the live UI. Both write the same
-- proposal artifacts at the end.
--
-- 2. WHO WRITES
--   - congress_runs: src/lib/congress-stepwise.ts (start/step/finalize)
--   - congress_interjections: POST /api/congress/runs/[id]/interject
--
-- 3. WHO READS
--   - congress_runs: GET /api/congress/runs/[id], /congress/[id]/live
--   - congress_interjections: read by the stepwise runner BEFORE each
--     persona, marks consumed_at when injected
--
-- 4. BACKFILL
--   No existing data — both tables start empty. Existing tactical_proposals
--   keep their `deliberation` JSON column as the historical record;
--   congress_runs is the new live-deliberation surface.

CREATE TABLE IF NOT EXISTS congress_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'weekly' | 'monthly' | 'postmortem' — different rosters
  kind                text NOT NULL CHECK (kind IN ('weekly', 'monthly', 'postmortem')),
  -- 'running' = in-flight; 'completed' = synthesizer done; 'failed' =
  -- synthesizer JSON didn't parse or some persona errored fatally.
  status              text NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running', 'completed', 'failed')),

  -- The full evidence pack (Wilson-annotated). Snapshotted at start
  -- so personas all see the same data even if underlying tables shift.
  evidence_pack       text NOT NULL,

  -- Ordered list of persona keys for this run (matches one of the
  -- WEEKLY_ROSTER / MONTHLY_ROSTER definitions in code). Stored so
  -- inspection later knows which persona was at index N even if the
  -- code changes.
  roster              jsonb NOT NULL,

  -- 0-indexed pointer to the next persona to run. NULL after
  -- status='completed' / 'failed' so we don't keep stepping a finished run.
  current_idx         int,

  -- Accumulated outputs: { persona_key: text } as personas finish.
  personas_completed  jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Final synthesizer JSON if status='completed' and parse succeeded.
  -- May still be NULL if parse failed (status would then be 'failed').
  synthesis           jsonb,

  -- IDs of artifacts emitted at finalize time (downstream of synthesis).
  tactical_proposal_id   uuid,
  template_proposal_id   uuid,

  failure_reason      text,

  started_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz
);

CREATE INDEX IF NOT EXISTS congress_runs_status_idx
  ON congress_runs (status, started_at DESC);

CREATE TABLE IF NOT EXISTS congress_interjections (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id              uuid NOT NULL REFERENCES congress_runs(id) ON DELETE CASCADE,

  -- The comment. Limited to ~2000 chars at write time so it doesn't
  -- balloon a persona prompt.
  body                text NOT NULL,
  author_rep_id       int NOT NULL REFERENCES sales_reps(id),

  -- Inject this comment AT-OR-AFTER personas[inject_after_idx]. So
  -- inject_after_idx=2 means "the next persona to run AFTER index 2
  -- sees this in its running context". Default = current_idx at
  -- submit time, i.e. "as soon as possible".
  inject_after_idx    int NOT NULL DEFAULT 0,

  -- Set when the stepwise runner has actually included this in a
  -- persona's prompt. NULL = pending; non-null = already in the
  -- running context of some persona.
  consumed_at         timestamptz,
  consumed_by_persona text,  -- which persona key consumed it

  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS congress_interjections_run_idx
  ON congress_interjections (run_id, consumed_at NULLS FIRST, inject_after_idx);

-- Pending-only partial index for the hot-path poll the runner does
-- before each persona.
CREATE INDEX IF NOT EXISTS congress_interjections_pending_idx
  ON congress_interjections (run_id, inject_after_idx)
  WHERE consumed_at IS NULL;
