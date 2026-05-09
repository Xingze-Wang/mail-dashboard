-- 067-sales-reps-lark-name.sql
-- ════════════════════════════════════════════════════════════════════
-- 1. SCHEMA CHANGE
-- New column sales_reps.lark_name — the canonical Han-character display
-- name from Lark /contact/v3/users (e.g. "杜雨洁"). Distinct from:
--   - sales_reps.name (customer-facing English handle, e.g. "Yujie")
--   - sales_reps.sender_name (what appears in email From + signature;
--     usually = name)
--   - sales_reps.english_handle (mig 064; same as name in current data)
--
-- The Han name is useful for: matching incoming Lark events by display
-- name, audit log readability, /admin/rep-trust UI showing both forms.
-- It is NOT used in customer-facing email — that stays as English.
--
-- 2. WHO WRITES?
-- - src/lib/onboarding.ts:provisionRep when a new rep onboards via Lark
--   (we have lark_name in pending_onboarding from triage time).
-- - scripts/backfill-lark-names.ts (the existing one — refactored to
--   write to lark_name instead of overwriting name).
--
-- 3. WHO READS?
-- - Future /admin/reps page (list view shows both English + Han)
-- - Lark identity matching when a rep DMs the bot (compare incoming
--   user's lark display name against sales_reps.lark_name to find
--   the rep faster than open_id lookup misses)
--
-- 4. BACKFILL
-- (b) For existing rows with lark_open_id set, scripts/backfill-lark-
--     names.ts re-fetches and writes lark_name. Manually pre-fill the
--     known three for immediate UX:
--       rep_id=2 → 杜雨洁
--       rep_id=3 → 曹鸿宇泽
--       rep_id=5 → 王幸泽

ALTER TABLE sales_reps
  ADD COLUMN IF NOT EXISTS lark_name text;

-- Pre-populate the three currently-bound reps with their known Han
-- names (we just had them in `name` until the user reverted to
-- English handles).
UPDATE sales_reps SET lark_name = '杜雨洁' WHERE id = 2 AND lark_name IS NULL;
UPDATE sales_reps SET lark_name = '曹鸿宇泽' WHERE id = 3 AND lark_name IS NULL;
UPDATE sales_reps SET lark_name = '王幸泽' WHERE id = 5 AND lark_name IS NULL;
