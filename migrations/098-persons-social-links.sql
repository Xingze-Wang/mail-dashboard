-- 098-persons-social-links.sql
--
-- 1. SCHEMA CHANGE
-- Two new columns on persons for the broader enrichment pipeline:
--   homepage         text — canonical homepage URL (one per person). NULL =
--                           not yet enriched OR enrichment found nothing.
--   twitter_handle   text — Twitter/X handle without the @ prefix
--                           (e.g. "geoffreyhinton"). NULL = unknown.
--
-- hf_users[] and github_users[] already exist — those are arrays because
-- some authors have multiple handles. homepage + twitter are single-
-- valued by convention.
--
-- 2. WHO WRITES?
-- src/lib/person-enrichment.ts:enrichPerson — runs 4 signals (homepage,
-- twitter, hf, github) with Promise.allSettled.
-- - Called by /api/pipeline/import (at lead-import time, bounded)
-- - Called by /api/cron/enrich-person (daily backfill for legacy rows)
-- - Called by scripts/backfill-person-enrichment.mjs (manual one-off)
--
-- 3. WHO READS?
-- - /pipeline page LeadRow renders a 4-pill cluster (HF/GH/site/twitter)
--   when the underlying person row has each signal populated
-- - LLM intro-prompt assembly may include "@<twitter>" or
--   "github.com/<handle>" as prompt context (future)
--
-- 4. BACKFILL
-- All existing rows: leave homepage + twitter_handle NULL. The new cron
-- + backfill script will populate over time. No urgency — pills just
-- don't render for unenriched persons, same as today's hf_users
-- coverage (7/4380 = 0.16%).

ALTER TABLE persons
  ADD COLUMN IF NOT EXISTS homepage text,
  ADD COLUMN IF NOT EXISTS twitter_handle text;

-- Index for the backfill cron's "find unenriched persons" query.
-- Partial WHERE keeps the index tiny.
CREATE INDEX IF NOT EXISTS persons_needs_enrichment_idx
  ON persons (updated_at)
  WHERE homepage IS NULL OR twitter_handle IS NULL
     OR cardinality(hf_users) = 0 OR cardinality(github_users) = 0;
