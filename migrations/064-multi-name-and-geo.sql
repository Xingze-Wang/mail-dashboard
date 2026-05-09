-- 064-multi-name-and-geo.sql
-- ════════════════════════════════════════════════════════════════════
-- 1. SCHEMA CHANGE
--
-- Task #31: multi-name model for reps. sales_reps already has
--   name (canonical, internal display)
--   sender_name (customer-facing in From: + signature)
--   lark_open_id / lark_email (Lark identity)
--
-- Adding two more facets so a rep's identity can be picked
-- contextually by templates / segment rules:
--   pinyin          — romanized name for academic correspondence
--                     (e.g. "Du Yujie" for 杜雨洁). Lets us route
--                     overseas-segment templates to use pinyin while
--                     CN-segment uses Han characters.
--   english_handle  — the rep's chosen English nickname, separate from
--                     pinyin (e.g. "Yujie" alone). Some reps prefer
--                     casual handles, others prefer pinyin or full
--                     name. This lets templates select per recipient.
--
-- Task #32: deeper geo for leads. Adding columns to pipeline_leads:
--   geo_province    — derived from email domain via SCHOOL_DATA
--                     extension. NULL for unknown / non-CN domains.
--   geo_city        — same source, finer grain. NULL when ambiguous.
--
-- Why on pipeline_leads not on persons: lead-side context is what
-- drives template selection at scan time. We compute once, then
-- segment_default rules read it. (persons may have multiple lead
-- rows with different schools; lead is the right grain.)
--
-- 2. WHO WRITES?
-- Reps: admin via /admin/rep-trust or settings page (UI work later).
--   For now: backfilled via scripts/seed-rep-names.mjs from canonical
--   knowledge ("Yujie" gets pinyin="Du Yujie", english_handle="Yujie").
-- Lead geo: scanner-config.ts SCHOOL_DATA gains province/city per
--   domain; src/lib/scanner.ts (or import path) reads it at lead
--   creation time and writes to pipeline_leads.
--
-- 3. WHO READS?
-- - template-assembler resolveLatePlaceholders gains optional
--   pinyin / english_handle inputs; per-segment overrides can pick
--   {{REP_NAME}} | {{REP_PINYIN}} | {{REP_HANDLE}} as the literal
--   substitution token.
-- - bench / inspector / insights pages can group by geo_province
--   instead of just geo (cn / overseas / edu).
--
-- 4. BACKFILL
-- (a) sales_reps.pinyin / english_handle: NULL on existing rows.
--     Templates fall back to sender_name when these are NULL — no
--     behavior change unless explicitly used.
-- (b) pipeline_leads.geo_province / geo_city: NULL on historical
--     rows. Forward writes only via the updated scanner. Optional
--     backfill: rerun scan for the last 30d? Out of scope here.

ALTER TABLE sales_reps
  ADD COLUMN IF NOT EXISTS pinyin text,
  ADD COLUMN IF NOT EXISTS english_handle text;

ALTER TABLE pipeline_leads
  ADD COLUMN IF NOT EXISTS geo_province text,
  ADD COLUMN IF NOT EXISTS geo_city text;

-- Index on (geo_province, status) for "show me Beijing-only leads"
-- queries on the bench. Partial: only active-pipeline statuses, since
-- archived rows aren't filtered by geo.
CREATE INDEX IF NOT EXISTS pipeline_leads_geo_province_idx
  ON pipeline_leads (geo_province)
  WHERE status IN ('ready', 'queued', 'sent');
