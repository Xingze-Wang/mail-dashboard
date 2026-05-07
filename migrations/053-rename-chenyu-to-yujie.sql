-- migrations/053-rename-chenyu-to-yujie.sql
--
-- 1. SCHEMA CHANGE
-- No DDL. Pure data: in-place UPDATE of sales_reps id=2.
-- Renames identity (name, sender_name, sender_email, login_email),
-- rotates password_hash. Keeps id=2 unchanged so every historical
-- row pointing to assigned_rep_id=2 / actor_rep_id=2 / marked_by_rep_id=2
-- keeps its attribution exactly as before.
--
-- 2. WHO WRITES THIS?
-- One-shot. Future writes to this row come from the existing /api/admin
-- and /api/auth/* routes the same way they did for Chenyu.
--
-- 3. WHO READS THIS?
-- Same code paths that already read sales_reps row 2:
--   - src/app/api/auth/login/route.ts (login_email/username + password_hash)
--   - src/app/api/pipeline/send/route.ts (sender_name + sender_email → Resend From:)
--   - src/lib/assignment.ts (id=2 → routing target for normal+domestic leads)
--   - src/components/help-bot.tsx and various dashboards (display name)
-- All historical pipeline_leads / emails / brief_lookups rows keep
-- assigned_rep_id=2 etc. — they automatically render under "Yujie"
-- after this UPDATE, which is the desired behavior (records over people:
-- the records stay attached to the rep_id, the person at that rep_id changes).
--
-- 4. BACKFILL FOR OLD ROWS
-- (d) Not applicable — no schema change. Existing rows that reference
-- rep id=2 (pipeline_leads.assigned_rep_id, emails.actor_rep_id,
-- brief_lookups.marked_by_rep_id, lark messages, etc.) all stay
-- correctly attached. The display name they render under flips from
-- "Chenyu" to "Yujie" automatically because the join target changed,
-- which is the whole point.
--
-- OPERATIONAL NOTES (NOT a migration concern, but the operator needs to know):
-- - sender_email = yujie@compute.miracleplus.com MUST exist as a verified
--   Resend sender before the next outbound send, or sends will fail.
-- - lark_open_id / lark_union_id are intentionally NOT touched. Yujie
--   should re-bind via /api/lark/bind from her own Lark account; until
--   then, helper-bot DMs from her account won't be recognized.
-- - wechat_id intentionally NOT touched (per user instruction). Yujie
--   can update via the dashboard once she has access.
-- - Password hash below is bcrypt of a randomly-generated 16-char password.
--   The plaintext is delivered out-of-band (not committed). Yujie should
--   change it on first login.

UPDATE sales_reps
SET
  name           = 'Yujie',
  sender_name    = 'Yujie',
  sender_email   = 'yujie@compute.miracleplus.com',
  login_email    = 'yujie@compute.miracleplus.com',
  password_hash  = '$2b$10$H2dbH4I7Q.fGMI.kY/69weyh1sKYVTYQWM/q06omcNA5Qk7/8fwgy'
WHERE id = 2
  AND name = 'Chenyu';  -- guard: don't run twice / don't clobber a different rep
