-- migrations/071-webhook-events-svix-dedup.sql
--
-- 1. SCHEMA CHANGE
-- Adds `svix_id text` to `webhook_events` plus a partial UNIQUE INDEX on it.
-- Resend signs every delivery with a unique `svix-id` header. When Resend
-- retries (network blip, 5xx from us, etc.) it sends the SAME svix-id again,
-- and today we INSERT a fresh row every time — duplicating events in what
-- CLAUDE.md calls "the canonical history". Downstream `attributeEventToContract`
-- (src/app/api/webhook/route.ts:262-299) double-counts on every retry.
--
-- The index is partial (`WHERE svix_id IS NOT NULL`) so historical rows
-- (pre-071) which have NULL svix_id don't all collide on a single key. New
-- rows from the webhook handler set svix_id from the request header; the
-- handler also uses ON CONFLICT DO NOTHING (via supabase upsert with
-- ignoreDuplicates) on this column so retries are absorbed silently.
--
-- 2. WHO WRITES THIS?
-- src/app/api/webhook/route.ts — every Resend POST, when the request has
-- an `svix-id` (or `webhook-id`) header. Inbound `email.received` and the
-- outbound event branch both write through this column.
-- Verification-failed diagnostic inserts intentionally do NOT set svix_id
-- (those are for the operator dashboard, not canonical history, and we
-- want them all to land regardless of payload).
--
-- 3. WHO READS THIS?
-- The unique index alone — no app code reads svix_id today. It exists
-- purely to enforce dedup at write time. `attributeEventToContract`
-- benefits indirectly because its source (webhook_events) is now
-- de-duplicated.
--
-- 4. BACKFILL FOR OLD ROWS
-- (c) intentionally NULL forever for legacy rows. The partial unique
-- index excludes NULLs, so legacy rows don't collide. Old rows' duplicates
-- (if any exist from prior Resend retries) are accepted as-is — fixing
-- write-side dedup is the goal; cleaning historical doubles would require
-- a separate one-shot we don't need right now.
--
-- Reference: docs/DATA_INTEGRITY_PLAN.md Tier 4 (silent-duplicate family),
-- SMOKE_TEST_REPORT_2026-05-09.md finding #8.

ALTER TABLE webhook_events
  ADD COLUMN IF NOT EXISTS svix_id text;

CREATE UNIQUE INDEX IF NOT EXISTS webhook_events_svix_id_uniq
  ON webhook_events (svix_id)
  WHERE svix_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
