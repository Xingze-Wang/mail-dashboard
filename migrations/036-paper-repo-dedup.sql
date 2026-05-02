-- Migration 036: Paper-repo level dedup
--
-- Adds repo + outreach columns to the existing `papers` table so we can:
-- (a) link a paper to its HF/GitHub repo (used by the auto-scanner to dedup
--     "different paper, same repo" — labs often post v2/v3 of a project under
--     a new arxiv id but the same github.com/lab/project repo).
-- (b) cache last_outreach_at/outreach_count on the paper itself, avoiding the
--     3-table join in paperWasRecentlyContacted() for the hot path.

ALTER TABLE papers ADD COLUMN IF NOT EXISTS hf_repo TEXT;
ALTER TABLE papers ADD COLUMN IF NOT EXISTS github_repo TEXT;
ALTER TABLE papers ADD COLUMN IF NOT EXISTS last_outreach_at TIMESTAMPTZ;
ALTER TABLE papers ADD COLUMN IF NOT EXISTS outreach_count INT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_papers_hf_repo ON papers (hf_repo) WHERE hf_repo IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_papers_github_repo ON papers (github_repo) WHERE github_repo IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_papers_last_outreach_at ON papers (last_outreach_at);

-- Backfill last_outreach_at + outreach_count from pipeline_leads
WITH agg AS (
  SELECT
    arxiv_id,
    MAX(sent_at) AS last_at,
    COUNT(*) FILTER (WHERE sent_at IS NOT NULL) AS cnt
  FROM pipeline_leads
  WHERE arxiv_id IS NOT NULL
  GROUP BY arxiv_id
)
UPDATE papers p SET
  last_outreach_at = agg.last_at,
  outreach_count = agg.cnt
FROM agg
WHERE p.arxiv_id = agg.arxiv_id AND agg.cnt > 0;

-- And merge in email_contact_history (legacy/imported sends)
WITH agg AS (
  SELECT
    paper_arxiv_id,
    MAX(contacted_at) AS last_at,
    COUNT(*) AS cnt
  FROM email_contact_history
  WHERE paper_arxiv_id IS NOT NULL
  GROUP BY paper_arxiv_id
)
UPDATE papers p SET
  last_outreach_at = GREATEST(COALESCE(p.last_outreach_at, '1970-01-01'::timestamptz), agg.last_at),
  outreach_count = p.outreach_count + agg.cnt
FROM agg
WHERE p.arxiv_id = agg.paper_arxiv_id;

-- Insert any arxiv_ids from history that aren't in papers yet
INSERT INTO papers (arxiv_id, title, last_outreach_at, outreach_count)
SELECT
  ech.paper_arxiv_id,
  MAX(ech.paper_title),
  MAX(ech.contacted_at),
  COUNT(*)
FROM email_contact_history ech
LEFT JOIN papers p ON p.arxiv_id = ech.paper_arxiv_id
WHERE ech.paper_arxiv_id IS NOT NULL AND p.arxiv_id IS NULL
GROUP BY ech.paper_arxiv_id;
