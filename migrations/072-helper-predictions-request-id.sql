-- migrations/072-helper-predictions-request-id.sql
--
-- 1. SCHEMA CHANGE
-- Adds `request_id text` to `helper_predictions` plus a partial UNIQUE INDEX
-- on it. POST /api/help/predictions today has no idempotency key — a
-- double-clicked "track this" button (or any retried client write) creates
-- N distinct rows with identical content. Smoke test reproduced this with
-- 10 concurrent identical POSTs → 10 rows. The accuracy snapshot in
-- /api/help/predictions/recent is then skewed (the same claim counted N
-- times against the same outcome).
--
-- The fix is a client-supplied (or server-derived) request_id stamped on
-- insert with ON CONFLICT DO NOTHING. Partial index lets legacy rows
-- (with NULL request_id) coexist without collision.
--
-- 2. WHO WRITES THIS?
-- src/app/api/help/predictions/route.ts (POST) → src/lib/predictions.ts
-- recordPrediction(). The handler reads `Idempotency-Key` request header
-- (preferred) or body.requestId; if neither is set, it derives a stable
-- key from `${repId}:${claim}:${targetEvent}:${targetLeadId ?? ""}` so a
-- fast double-tap with no client-supplied key still dedups. Hash is sha256
-- truncated to 32 hex chars — short enough for a btree key, collision-
-- safe within a rep's lifetime.
--
-- 3. WHO READS THIS?
-- The unique index alone. No app code reads request_id; it exists purely
-- to enforce dedup at write time.
--
-- 4. BACKFILL FOR OLD ROWS
-- (c) intentionally NULL forever for legacy rows. The partial unique
-- index excludes NULLs so existing rows don't collide. Pre-072 dupes
-- already exist; cleaning them is out of scope for this migration —
-- the goal is to stop creating new dupes.
--
-- Reference: SMOKE_TEST_REPORT_2026-05-09.md finding #21.

ALTER TABLE helper_predictions
  ADD COLUMN IF NOT EXISTS request_id text;

CREATE UNIQUE INDEX IF NOT EXISTS helper_predictions_request_id_uniq
  ON helper_predictions (request_id)
  WHERE request_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
