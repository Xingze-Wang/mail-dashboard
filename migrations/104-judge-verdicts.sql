-- migrations/104-judge-verdicts.sql
--
-- 1. SCHEMA CHANGE
-- Adds two columns to pipeline_leads for the 3-model semantic judge layer
-- (Sonnet 4.6 + Gemini 2.5 Flash direct + GLM 4.7) that runs AFTER the
-- structural QC lock from migration 103:
--
--   judge_verdict  jsonb — latest consensus result for this draft.
--                          Shape:
--                          {
--                            "passed": bool,            // 2-of-3 agreed-ship
--                            "block_votes": int,        // 0-3
--                            "valid_judges": int,       // how many returned valid JSON
--                            "sonnet": {instruction_followed, paper_relevant, should_block, reasoning} | {error},
--                            "glm":    {...} | {error},
--                            "gemini": {...} | {error},
--                            "mean_instr": number | null,
--                            "mean_rel":   number | null,
--                            "ts":         iso8601,
--                            "model_versions": {sonnet, gemini, glm},
--                          }
--   judge_status   text  — denormalized verdict for cheap filtering:
--                          'pass' | 'soft_warn' | 'human_review' | 'pending' | NULL
--                          pending = scheduled but not yet judged.
--
-- 2. WHO WRITES?
-- src/app/api/pipeline/draft-queue/route.ts (after structural QC succeeds,
-- runs the 3-model judge and writes both columns). Also the backfill
-- script scripts/_backfill-judge-ready.mjs writes them for existing ready
-- drafts in one shot.
--
-- 3. WHO READS?
-- - src/app/api/pipeline/send/route.ts + batch-send: defensive read; if
--   judge_status='human_review' refuse to send unless rep explicitly
--   overrides (sets a query param "override_judge=1").
-- - Admin UI at /admin/qc-quarantine (future): shows judge_status='human_review'.
-- - scripts/_audit-*.mjs: aggregate stats over judge_verdict.
--
-- 4. BACKFILL FOR OLD ROWS
-- (b) Backfill route — scripts/_backfill-judge-ready.mjs runs the 3-model
--     judge against every status='ready' lead currently in the table
--     (~1976 leads at deploy time) and populates judge_verdict. Done in
--     one-shot, locally against prod, NOT a serverless function — Sonnet
--     calls at ~1s each * 1976 = 33 min wall time. Budget ~$15. Pre-103
--     rows that are not 'ready' (already 'sent') stay NULL forever — we
--     don't re-judge history because the email is already out.

ALTER TABLE pipeline_leads
  ADD COLUMN IF NOT EXISTS judge_verdict jsonb,
  ADD COLUMN IF NOT EXISTS judge_status  text;

-- Quick filter for admin UI: show me everything semantically quarantined.
CREATE INDEX IF NOT EXISTS pipeline_leads_judge_quarantined_idx
  ON pipeline_leads (created_at DESC)
  WHERE status = 'judge_quarantined';

-- ─── status / judge_status values (no DDL — informational only) ──────
--
-- pipeline_leads.status (extended from mig 103):
--   queued / drafting / ready / sending / sent / replied / skipped (existing)
--   qc_quarantined    - draft hard-failed STRUCTURAL QC twice (mig 103);
--                       admin reviews.
--   judge_quarantined - draft passed structural QC but failed the 3-model
--                       semantic judge (mig 104). At least 1 of {Sonnet,
--                       GLM, Gemini} voted should_block=true. Per
--                       2026-05-19 user call: ANY judge block is enough
--                       to quarantine (aggressive bar). Same admin
--                       review workflow as qc_quarantined; the two are
--                       kept separate so admin can tell apart "the model
--                       went rogue" (structural) from "the model wrote
--                       fluent but inaccurate copy" (semantic).
--
-- judge_status (the column added by THIS migration):
--   NULL          - never judged. Send path treats same as 'pass' for
--                   backward compat (legacy drafts).
--   pending       - scheduled for judging, hasn't been hit yet.
--   pass          - block_votes == 0; ship freely.
--   blocked       - block_votes >= 1; quarantined (status set to
--                   'judge_quarantined').
