-- 081-sales-reps-aliases.sql
-- ════════════════════════════════════════════════════════════════════
-- 1. SCHEMA CHANGE
--
-- sales_reps.aliases: text[] of alternate names the bot should treat
-- as referring to this rep. Each rep has a canonical Sales name
-- (Leo / Yujie / Ethan / Xingze / Xuwen) but is referred to in
-- practice by several:
--   - Lark display name (Chinese: 曹鸿宇泽)
--   - Pinyin (caohongyuze, hongyuze)
--   - Short form (Cao, 宇泽)
--   - English sender_name (already on the row)
--
-- Without this list, "把张三给 caohongyuze" makes list_reps return
-- {id:3, name:"Ethan"} and the LLM has to guess the connection.
-- With it, the lookup is deterministic.
--
-- 2. WHO WRITES
--   - One-time seed via this migration (Ethan, Yujie, Xingze, Xuwen).
--   - Admin can append via /admin or future helper tool.
--
-- 3. WHO READS
--   - listReps() in src/lib/helper-read-tools.ts surfaces aliases
--     in the tool result so the helper-bot prompt can match on them.
--
-- 4. BACKFILL
--   Seeded inline below for known reps. Future reps get empty array.
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE sales_reps
  ADD COLUMN IF NOT EXISTS aliases text[] NOT NULL DEFAULT ARRAY[]::text[];

-- Seed known aliases. Each list includes (a) Lark display name in CN,
-- (b) pinyin variants, (c) family-name-only short form. Leon (id=1)
-- has no Lark name so we only seed Chinese-display.
UPDATE sales_reps SET aliases = ARRAY[
  '曹鸿宇泽',  'caohongyuze', 'hongyuze', 'Cao', '宇泽', 'caohongyu', 'caohongyuzhe'
] WHERE id = 3;  -- Ethan

UPDATE sales_reps SET aliases = ARRAY[
  '杜雨洁', 'duyujie', 'yujie', 'Du', '雨洁'
] WHERE id = 2;  -- Yujie

UPDATE sales_reps SET aliases = ARRAY[
  '王幸泽', 'wangxingze', 'xingze', 'Wang', '幸泽'
] WHERE id = 5;  -- Xingze

UPDATE sales_reps SET aliases = ARRAY[
  'Leo', 'leo'
] WHERE id = 1;  -- Leo

UPDATE sales_reps SET aliases = ARRAY[
  'Xuwen', 'xuwen'
] WHERE id = 7;  -- Xuwen
