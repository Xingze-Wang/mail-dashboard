-- migrations/103-draft-qc-tracking.sql
--
-- 1. SCHEMA CHANGE
-- Adds three columns to pipeline_leads to track structural QC verdicts
-- produced by the new src/lib/email-structural-qc.ts module + the LLM
-- rewrite path in src/lib/draft-rewrite.ts:
--
--   qc_verdict        jsonb         — latest QC result for the current
--                                     draft_html: {ok, hard:[{code,...}],
--                                     soft:[...]} or NULL if never run.
--   qc_retry_count    int default 0 — how many rewrite attempts this
--                                     lead's current draft has gone
--                                     through (0 = first-pass passed,
--                                     1 = passed after 1 rewrite, 2 =
--                                     passed after 2, NULL effectively
--                                     same as 0).
--   qc_history        jsonb         — append-only-ish log of {ts, attempt,
--                                     code, intro_before, intro_after,
--                                     qc_codes_after}. Capped to last 5
--                                     entries application-side; readers
--                                     must tolerate any length.
--
-- Also introduces a new status string value "qc_quarantined" for leads
-- whose draft hard-failed QC twice in a row. Status is a free-text TEXT
-- column (no enum constraint), so this requires no DDL — but downstream
-- consumers MUST be taught the new value. See docs section at bottom.
--
-- 2. WHO WRITES?
-- src/app/api/pipeline/draft-queue/route.ts (the only writer):
--   - on first-pass QC PASS: qc_verdict = {ok:true, ...}, qc_retry_count = 0
--   - after rewrite succeeds: qc_verdict reflects post-rewrite QC,
--     qc_retry_count = 1 or 2, qc_history appends the attempts
--   - after rewrite exhausts: status = "qc_quarantined",
--     qc_verdict = last failed QC, qc_retry_count = 2
--
-- 3. WHO READS?
-- - src/app/api/pipeline/send/route.ts + batch-send: defensive read on
--   qc_verdict before sending (skip with reason "qc_blocked" if hard
--   issues are present, regardless of status).
-- - Future admin UI at /admin/qc-quarantine to surface rows that need
--   human review.
-- - scripts/_audit-* scripts can read qc_verdict directly without
--   re-running the lock.
--
-- 4. BACKFILL FOR OLD ROWS
-- (c) Intentionally NULL forever for pre-103 rows. NULL qc_verdict means
--     "no QC has run on this draft yet" — the send-path treats NULL the
--     same as ok=true for backwards compatibility (we don't want to block
--     historical drafts on a column they never had a chance to populate).
--     The defensive QC re-check in send-path will still run validateEmail-
--     Structure inline so we catch any hard issues even for NULL rows.
--     Old rows can re-acquire a verdict any time draft-queue regenerates
--     their draft (e.g. after Python rescan).

ALTER TABLE pipeline_leads
  ADD COLUMN IF NOT EXISTS qc_verdict     jsonb,
  ADD COLUMN IF NOT EXISTS qc_retry_count int  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS qc_history     jsonb;

-- Optional: a partial index so admin UI can list quarantined leads cheaply.
-- Postgres won't error if the index already exists.
CREATE INDEX IF NOT EXISTS pipeline_leads_qc_quarantined_idx
  ON pipeline_leads (created_at DESC)
  WHERE status = 'qc_quarantined';

-- Optional: an index for "drafts with HARD QC issues" so we can quickly
-- find rows the lock failed on, even those still in `ready`/`queued`.
-- Uses a GIN expression index on the hard array length.
-- Skipped for now — premature; revisit when /admin/qc-quarantine ships.

-- ─── Status value reference (no DDL — informational only) ────────────
--
-- pipeline_leads.status is text. As of this migration, valid values are:
--   queued          - imported, awaiting draft generation
--   drafting        - draft-queue worker has claimed it
--   ready           - draft passed QC, awaiting human send
--   sending         - atomically claimed by send/batch-send (race lock)
--   sent            - Resend accepted, sent_at populated
--   replied         - inbound reply received
--   skipped         - flagged to skip outreach
--   qc_quarantined  - NEW in 103: draft hard-failed QC twice; needs
--                     human review or manual override before send.
--                     Treated like 'queued' for retry purposes (the
--                     daily cron does NOT pick these up — admin only).
