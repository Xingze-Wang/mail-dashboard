-- Migration 020: brief_lookups attribution — column guard + historical backfill.
--
-- Background: 49 historical brief_lookups rows had marked_by_rep_id = NULL.
-- Production deployed the rep-attribution writer at 2026-04-24 03:28 UTC
-- (commit 36bd75e); every WeChat click before that point dropped the
-- field. Since then, new clicks land with the correct rep — but the
-- 49 historical rows were never attributed.
--
-- Per-rep dashboards filter `WHERE marked_by_rep_id = <repId>`, so all
-- historical conversions are invisible to the rep who took them.
--
-- Backfill heuristic (PRAGMATIC, not strict):
--   The strict rule is "rep who CLICKED the WeChat-add button gets
--   credit." We don't have a record of who clicked these old rows.
--   The pragmatic stand-in is "the rep who SENT the email is the rep
--   who marked the WeChat add." Empirically those are usually the
--   same person (a rep follows their own threads). For the small
--   number of cases where another rep clicked on someone else's
--   email, this misattributes — but the alternative is leaving
--   conversions invisible to everyone, which is worse.
--
-- Resolution chain (first match wins):
--   1. brief_lookups.lead_id → pipeline_leads.assigned_rep_id
--      (Best signal: a lead has been formally assigned to a rep.)
--   2. brief_lookups.query (= recipient email) → emails.to → emails.rep_id
--      (Covers brief_lookups rows where lead_id is NULL or the lead
--      has no assigned_rep_id. Picks the most recent email to that
--      recipient — closest in time to the WeChat add.)
--   3. brief_lookups.query → emails.to → emails.from substring
--      → sales_reps.sender_email
--      (Covers pre-migration-014 emails where rep_id wasn't stamped.
--      Uses the earliest send to that recipient — first contact = the
--      rep who started the conversation.)
--
-- Rows that match none of the above stay NULL (genuinely unknown).
--
-- Idempotent: re-running only touches rows that are still NULL.

BEGIN;

-- ── Step 1: ensure columns exist ──
-- Belt-and-suspenders idempotent of migration 012.
ALTER TABLE brief_lookups
  ADD COLUMN IF NOT EXISTS marked_by_rep_id integer;
ALTER TABLE brief_lookups
  ADD COLUMN IF NOT EXISTS marked_by_email  text;

CREATE INDEX IF NOT EXISTS idx_brief_lookups_marked_by
  ON brief_lookups (marked_by_rep_id)
  WHERE marked_by_rep_id IS NOT NULL;

-- Force PostgREST schema cache reload — without this, the API layer
-- can take minutes to notice new columns and silently drops them
-- from incoming POST bodies.
NOTIFY pgrst, 'reload schema';

-- ── Step 2a: attribute via lead_id → pipeline_leads.assigned_rep_id ──
UPDATE brief_lookups bl
SET marked_by_rep_id = pl.assigned_rep_id
FROM pipeline_leads pl
WHERE bl.added_wechat = true
  AND bl.marked_by_rep_id IS NULL
  AND bl.lead_id IS NOT NULL
  AND bl.lead_id = pl.id
  AND pl.assigned_rep_id IS NOT NULL;

-- ── Step 2b: attribute via query (recipient email) → emails.rep_id ──
-- Most recent email to that recipient wins.
UPDATE brief_lookups bl
SET marked_by_rep_id = sub.rep_id
FROM (
  SELECT DISTINCT ON (lower(trim(e.to)))
    lower(trim(e.to)) AS recipient,
    e.rep_id
  FROM emails e
  WHERE e.rep_id IS NOT NULL
    AND e.to IS NOT NULL
  ORDER BY lower(trim(e.to)), e.created_at DESC
) sub
WHERE bl.added_wechat = true
  AND bl.marked_by_rep_id IS NULL
  AND bl.query IS NOT NULL
  AND lower(trim(bl.query)) = sub.recipient;

-- ── Step 2c: attribute via emails.from substring → sales_reps.sender_email ──
-- Last-resort fallback for pre-migration-014 emails (no rep_id stamped).
-- Earliest send wins (first contact = the rep who owns the conversation).
UPDATE brief_lookups bl
SET marked_by_rep_id = sub.rep_id
FROM (
  SELECT DISTINCT ON (lower(trim(e.to)))
    lower(trim(e.to)) AS recipient,
    r.id AS rep_id
  FROM emails e
  JOIN sales_reps r
    ON lower(e.from) LIKE '%' || lower(r.sender_email) || '%'
  WHERE e.to IS NOT NULL
  ORDER BY lower(trim(e.to)), e.created_at ASC
) sub
WHERE bl.added_wechat = true
  AND bl.marked_by_rep_id IS NULL
  AND bl.query IS NOT NULL
  AND lower(trim(bl.query)) = sub.recipient;

-- ── Step 3: backfill marked_by_email from whoever we just attributed ──
-- Keeps the audit trail consistent so DISTINCT-by-email queries match
-- the per-rep_id COUNT queries.
UPDATE brief_lookups bl
SET marked_by_email = COALESCE(r.login_email, r.sender_email)
FROM sales_reps r
WHERE bl.added_wechat = true
  AND bl.marked_by_rep_id IS NOT NULL
  AND bl.marked_by_email IS NULL
  AND bl.marked_by_rep_id = r.id;

-- ── Diagnostics ──
SELECT
  'brief_lookups attribution' AS step,
  COUNT(*) FILTER (WHERE added_wechat = true) AS total_wechat,
  COUNT(*) FILTER (WHERE added_wechat = true AND marked_by_rep_id IS NOT NULL) AS attributed,
  COUNT(*) FILTER (WHERE added_wechat = true AND marked_by_rep_id IS NULL) AS still_null
FROM brief_lookups;

SELECT
  r.id,
  r.name,
  COUNT(DISTINCT bl.lead_id) FILTER (WHERE bl.lead_id IS NOT NULL) AS distinct_lead_wechat,
  COUNT(*) FILTER (WHERE bl.lead_id IS NULL) AS name_only_wechat
FROM sales_reps r
LEFT JOIN brief_lookups bl
  ON bl.marked_by_rep_id = r.id
 AND bl.added_wechat = true
GROUP BY r.id, r.name
ORDER BY r.id;

COMMIT;
