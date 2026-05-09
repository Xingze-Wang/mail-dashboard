-- 068-template-ratings.sql
-- ════════════════════════════════════════════════════════════════════
-- 1. SCHEMA CHANGE
-- New table template_ratings: multi-dim 1-10 scores for an
-- email_templates row, given by either the editor LLM (when proposal
-- gate runs) or by a human admin (via /templates/[id]/judge UI).
--
-- Six dimensions, all 1-10:
--   politeness         — 是不是 礼貌 / 不卑微 / 不过热的拿捏好
--   clarity            — 30 秒能不能 get 到"我能不能用上"
--   peer_register      — 平等同行语气 vs 销售腔 (10 = 完美同行)
--   brand_fit          — 务实 / 坦然 / 简朴 / 谦逊 四性贴合度
--   factual_accuracy   — 数字 / program facts 是不是符合
--   naturalness        — 读起来像不像真人写的 (vs LLM 一眼能看出)
--
-- Plus reasoning (free text) and which model_id (for AI rows).
-- Composite UNIQUE on (template_id, rater_kind, rater_id) so re-rates
-- update existing rows.
--
-- 2. WHO WRITES?
--   - rater_kind='ai': src/lib/template-prose-pipeline.ts:editParagraph
--     emits multi-dim scores alongside the verdict; we save them here.
--   - rater_kind='human': admin via POST /api/templates/[id]/judge
--     (one row per (template, admin) so multiple admins can rate
--     independently and we see human-vs-human spread too)
--
-- 3. WHO READS?
--   - /templates/[id]/inspect: shows the AI scores for this proposal
--   - /templates/[id]/judge: human rating UI; shows AI scores side-by-
--     side for calibration awareness
--   - /admin/template-insights (future): aggregate diffs to surface
--     systematic AI-vs-human disagreement patterns
--
-- 4. BACKFILL
--   Empty at start. Rows accumulate as new proposals are gated and
--   admins start rating templates.

CREATE TABLE IF NOT EXISTS template_ratings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id     uuid NOT NULL REFERENCES email_templates(id) ON DELETE CASCADE,
  rater_kind      text NOT NULL CHECK (rater_kind IN ('ai', 'human')),
  rater_id        int  REFERENCES sales_reps(id),  -- NULL when AI
  model_id        text,                             -- e.g. "gemini-3-flash"

  -- Six dimensions, 1-10 each. CHECK constraints keep values bounded.
  politeness        int NOT NULL CHECK (politeness        BETWEEN 1 AND 10),
  clarity           int NOT NULL CHECK (clarity           BETWEEN 1 AND 10),
  peer_register     int NOT NULL CHECK (peer_register     BETWEEN 1 AND 10),
  brand_fit         int NOT NULL CHECK (brand_fit         BETWEEN 1 AND 10),
  factual_accuracy  int NOT NULL CHECK (factual_accuracy  BETWEEN 1 AND 10),
  naturalness      int NOT NULL CHECK (naturalness        BETWEEN 1 AND 10),

  -- Free-text reasoning. Required for AI (always emitted), optional
  -- for human (admin can score without justifying every dim).
  reasoning       text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Re-rates upsert. AI re-runs replace the AI row; humans get one row
-- per (template, admin), so two admins rating the same template
-- produce two rows.
CREATE UNIQUE INDEX IF NOT EXISTS template_ratings_unique
  ON template_ratings (template_id, rater_kind, COALESCE(rater_id, 0));

CREATE INDEX IF NOT EXISTS template_ratings_template_idx
  ON template_ratings (template_id);

CREATE INDEX IF NOT EXISTS template_ratings_kind_idx
  ON template_ratings (rater_kind, created_at DESC);
