-- Migration 090: per-query relevance recall for helper_learnings
--
-- 1. SCHEMA CHANGE
--   - Add fts_doc tsvector column to helper_learnings, indexed with GIN
--   - Add triggers text[] column for Claude-Code-style skill activation
--     ("this skill applies when query mentions any of these phrases")
--   - Trigger to keep fts_doc in sync with body on insert/update
--
-- 2. WHO WRITES
--   - The trigger maintains fts_doc automatically. Code never touches it.
--   - triggers is set when admin promotes a learning into a skill — Leon
--     proposes the trigger words at classification time. Default: empty
--     array (skill loads always — backwards compat).
--
-- 3. WHO READS
--   - loadRelevantLearnings (replaces loadActiveLearnings) uses
--     ts_rank_cd(fts_doc, plainto_tsquery(query)) for memory ranking
--     and triggers @> overlap for skill activation gating.
--
-- 4. BACKFILL
--   - The trigger runs ON INSERT/UPDATE, so existing rows need a
--     one-time UPDATE to populate fts_doc. We do that inline.
--
-- Idempotent.

-- Use 'simple' config so non-English (Chinese) tokens still index as-is.
-- The Chinese chars come through as individual lexemes which is fine
-- for substring-style matching.
ALTER TABLE helper_learnings
  ADD COLUMN IF NOT EXISTS fts_doc tsvector,
  ADD COLUMN IF NOT EXISTS triggers text[] NOT NULL DEFAULT '{}'::text[];

CREATE INDEX IF NOT EXISTS helper_learnings_fts_idx
  ON helper_learnings USING gin (fts_doc)
  WHERE superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS helper_learnings_triggers_idx
  ON helper_learnings USING gin (triggers)
  WHERE superseded_at IS NULL AND kind = 'skill';

CREATE OR REPLACE FUNCTION helper_learnings_fts_update() RETURNS trigger AS $$
BEGIN
  NEW.fts_doc :=
    setweight(to_tsvector('simple', coalesce(NEW.body, '')), 'A') ||
    setweight(to_tsvector('simple', array_to_string(NEW.triggers, ' ')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.kind, '')), 'C');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS helper_learnings_fts_trg ON helper_learnings;
CREATE TRIGGER helper_learnings_fts_trg
  BEFORE INSERT OR UPDATE OF body, triggers, kind
  ON helper_learnings
  FOR EACH ROW EXECUTE FUNCTION helper_learnings_fts_update();

-- One-shot backfill: touch every existing row so the trigger fires
UPDATE helper_learnings SET body = body WHERE fts_doc IS NULL;

-- RPC for query-relevance ranking. Returns the top-K most relevant
-- non-superseded learnings for a free-text query.
--
-- We build the tsquery as OR-joined lexemes (rather than plainto_tsquery
-- which AND-joins) so a query like "Yujie 这周怎么样" matches a memory
-- mentioning just "Yujie". This is what we want for relevance ranking
-- — we score by overlap, not require every token to match.
CREATE OR REPLACE FUNCTION helper_learnings_search(
  query_text text,
  rep_scope int,
  limit_n int DEFAULT 20
) RETURNS TABLE (
  id uuid,
  scope_rep_id int,
  kind text,
  body text,
  evidence jsonb,
  confidence double precision,
  triggers text[],
  rank double precision,
  created_at timestamptz
)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  q_text text;
  q_built text;
  tsq tsquery;
BEGIN
  q_text := coalesce(trim(query_text), '');
  IF q_text = '' THEN
    -- Empty query: return everything, ranked 0
    RETURN QUERY
      SELECT l.id, l.scope_rep_id, l.kind, l.body, l.evidence,
             l.confidence::double precision, l.triggers,
             0::double precision AS rank, l.created_at
      FROM helper_learnings l
      WHERE l.superseded_at IS NULL
        AND (l.scope_rep_id IS NULL OR l.scope_rep_id = rep_scope OR rep_scope IS NULL)
      ORDER BY
        CASE WHEN l.kind = 'skill' THEN 0 ELSE 1 END,
        l.created_at DESC
      LIMIT limit_n;
    RETURN;
  END IF;

  -- Tokenize via to_tsvector (gives us the same lexemes the index uses),
  -- then OR-join them into a tsquery.
  SELECT string_agg(lexeme, ' | ')
    INTO q_built
    FROM unnest(tsvector_to_array(to_tsvector('simple', q_text))) AS lexeme;

  IF q_built IS NULL OR q_built = '' THEN
    -- No usable lexemes — fall back to empty-query path
    RETURN QUERY
      SELECT l.id, l.scope_rep_id, l.kind, l.body, l.evidence,
             l.confidence::double precision, l.triggers,
             0::double precision AS rank, l.created_at
      FROM helper_learnings l
      WHERE l.superseded_at IS NULL
        AND (l.scope_rep_id IS NULL OR l.scope_rep_id = rep_scope OR rep_scope IS NULL)
      ORDER BY
        CASE WHEN l.kind = 'skill' THEN 0 ELSE 1 END,
        l.created_at DESC
      LIMIT limit_n;
    RETURN;
  END IF;

  tsq := to_tsquery('simple', q_built);

  RETURN QUERY
    SELECT l.id, l.scope_rep_id, l.kind, l.body, l.evidence,
           l.confidence::double precision, l.triggers,
           ts_rank_cd(l.fts_doc, tsq)::double precision AS rank,
           l.created_at
    FROM helper_learnings l
    WHERE l.superseded_at IS NULL
      AND (l.scope_rep_id IS NULL OR l.scope_rep_id = rep_scope OR rep_scope IS NULL)
    ORDER BY
      CASE WHEN l.kind = 'skill' THEN 0 ELSE 1 END,
      ts_rank_cd(l.fts_doc, tsq) DESC,
      l.created_at DESC
    LIMIT limit_n;
END
$$;

NOTIFY pgrst, 'reload schema';
