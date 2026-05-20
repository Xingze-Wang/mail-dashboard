-- migrations/105-paper-type-log.sql
--
-- 1. SCHEMA CHANGE
-- Adds two columns to pipeline_leads to log what TYPE of paper each lead
-- targets. NOT a gate — purely analytics. Per 2026-05-20 user call: log
-- now, look at conversion rate by type later, then decide if any type
-- should be filtered out at import.
--
--   paper_type        text — one of: "empirical_method" | "benchmark" |
--                            "theory" | "survey" | "null_result" |
--                            "measurement" | "position" | "unknown"
--   paper_type_reason text — one-sentence justification from the classifier
--                            (so a future analyst can audit a label without
--                            re-running the classifier)
--
-- 2. WHO WRITES?
-- src/app/api/pipeline/import/route.ts — classifier runs once per new lead
-- at import time. Best-effort: failure writes paper_type='unknown' and
-- doesn't block the lead.
-- Also src/app/api/pipeline/scan/route.ts if/when we want to backfill.
--
-- 3. WHO READS?
-- - Future /admin/conversion-matrix could pivot by paper_type to see
--   "benchmark papers have 2x lower reply rate" etc.
-- - Future product call could turn paper_type into a gate.
-- - Sales reps on /pipeline could filter ("hide survey papers").
--
-- 4. BACKFILL FOR OLD ROWS
-- (c) Intentionally NULL forever for pre-105 rows. NULL means "we never
--     classified this lead." Consumers must tolerate NULL. A separate
--     backfill script can be written if we want historical analytics —
--     ~$0.001 per paper × 5000 leads = $5 one-shot.

ALTER TABLE pipeline_leads
  ADD COLUMN IF NOT EXISTS paper_type        text,
  ADD COLUMN IF NOT EXISTS paper_type_reason text;

-- Cheap index for future analytics (paper_type pivots).
CREATE INDEX IF NOT EXISTS pipeline_leads_paper_type_idx
  ON pipeline_leads (paper_type)
  WHERE paper_type IS NOT NULL;

-- ─── paper_type values (informational only — text column, no constraint) ──
--
--   empirical_method  - "we built X, here are the numbers". Most common.
--                       Compute upsell makes sense ("validate at larger scale").
--   benchmark         - "we built a benchmark / eval suite". Compute upsell
--                       should be "run more models on it", not "fine-tune".
--   theory            - "we prove X". Lean / formal verification / mathematical
--                       results. Compute upsell rarely fits — these scale by
--                       proof depth not GPU count.
--   survey            - "we synthesize N prior works". No compute need.
--   null_result       - "we expected X but found NOT-X". Compute upsell often
--                       backfires (the paper's point is that scaling didn't help).
--   measurement       - "we characterize / diagnose X". Compute upsell fits if
--                       the diagnostic could be applied to bigger models.
--   position          - "we argue X". Opinion / position paper. No compute hook.
--   unknown           - classifier failed or wasn't run.
