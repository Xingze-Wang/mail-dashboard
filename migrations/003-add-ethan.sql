-- ═══════════════════════════════════════════════════════════════════
-- Migration 003: Seed Ethan and Chenyu (the missing two reps).
-- Run in Supabase SQL Editor (or POST /api/migrate/add-ethan).
--
-- Defaults — change in /settings (or with a follow-up UPDATE) later if
-- you want different values:
--   Chenyu:
--     sender_email: chenyu@compute.miracleplus.com
--     sender_name:  Chenyu
--     wechat_id:    chenyu_wechat_TBD   ← USER: replace with Chenyu's real WeChat
--     active:       true
--   Ethan:
--     sender_email: ethan@compute.miracleplus.com
--     sender_name:  Ethan
--     wechat_id:    hnyhc5
--     active:       true
--
-- ON CONFLICT DO NOTHING is keyed on the implicit UNIQUE-on-id, but we
-- also guard against duplicate wechat_id by checking first inside the
-- equivalent /api/migrate/add-ethan route. SQL inserts here are append-
-- only; running twice will create duplicates if PRIMARY KEY id is auto.
-- ═══════════════════════════════════════════════════════════════════

-- Chenyu (id 2 if Leo is 1 and table is fresh)
INSERT INTO sales_reps (name, sender_email, sender_name, wechat_id, active)
SELECT 'Chenyu', 'chenyu@compute.miracleplus.com', 'Chenyu', 'chenyu_wechat_TBD', true
WHERE NOT EXISTS (
  SELECT 1 FROM sales_reps WHERE wechat_id = 'chenyu_wechat_TBD' OR name = 'Chenyu'
);

-- Ethan (id 3 if Leo=1, Chenyu=2 and table is fresh)
INSERT INTO sales_reps (name, sender_email, sender_name, wechat_id, active)
SELECT 'Ethan', 'ethan@compute.miracleplus.com', 'Ethan', 'hnyhc5', true
WHERE NOT EXISTS (
  SELECT 1 FROM sales_reps WHERE wechat_id = 'hnyhc5' OR name = 'Ethan'
);
