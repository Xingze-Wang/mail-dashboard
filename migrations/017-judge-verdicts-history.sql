-- ═══════════════════════════════════════════════════════════════════
-- Migration 017: Preserve judge verdict history across re-judges
--
-- /api/drift/rejudge was overwriting judge_verdicts + judge_avg each
-- run, destroying the baseline it was meant to compare against. The
-- whole point of re-judging is to detect rubric drift over time.
--
-- Adds judge_verdicts_history (JSONB array of past verdicts + avg +
-- timestamp). The rejudge route now prepends the current verdicts to
-- this array before overwriting current, capped at 20 entries so
-- JSONB doesn't grow unbounded.
--
-- Idempotent.
-- ═══════════════════════════════════════════════════════════════════

alter table pipeline_leads
  add column if not exists judge_verdicts_history jsonb
    not null default '[]'::jsonb;
