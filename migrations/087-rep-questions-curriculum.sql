-- Migration 087: rep_questions + canonical_onboarding_topics
--
-- 1. SCHEMA CHANGE
--   - rep_questions: every rep question Leon sees, normalized, with
--     handling outcome (solo / escalated / deferred). The substrate for
--     the curriculum miner.
--   - canonical_onboarding_topics: the curriculum itself — topics
--     that have been asked by ≥N distinct reps and admin has approved
--     for proactive front-loading.
--
-- 2. WHO WRITES
--   - rep_questions: lark-agent.ts (logQuestion helper), called on
--     every inbound user turn after intent classification.
--   - canonical_onboarding_topics: cron miner (scripts/cron path) +
--     admin via /api/admin/onboarding-topics POST.
--
-- 3. WHO READS
--   - rep_questions: curriculum miner (clusters by similarity), admin
--     dashboard (/admin/curriculum), Leon's get_recent_questions tool.
--   - canonical_onboarding_topics: Leon's first-DM-to-new-rep flow
--     reads top-N topics and front-loads answers.
--
-- 4. BACKFILL
--   - No backfill — these are new event streams that fill forward.
--   - The miner runs nightly via /api/cron and will pick up patterns
--     within ~3 days of regular DM traffic.
--
-- Idempotent.

-- Trigram extension required for the normalized clustering index below
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS rep_questions (
  id              uuid primary key default gen_random_uuid(),
  rep_id          integer null references sales_reps(id) on delete set null,
  raw_text        text not null,                -- exactly what the rep typed
  normalized      text not null,                -- canonical form: "how do I X?" stripped of rep-specific names
  -- How Leon handled this turn:
  --   'solo'      = Leon answered without escalating (high confidence)
  --   'escalated' = Leon called escalate_to_admin
  --   'deferred'  = Leon said "let me think / I'll check" without action (bad — flag for review)
  outcome         text not null check (outcome in ('solo', 'escalated', 'deferred')),
  -- If escalated, the admin_inbox row id; if solo, the learning_id that
  -- backed the answer (when one was used)
  related_inbox_id   uuid null references admin_inbox(id) on delete set null,
  related_learning_id uuid null references helper_learnings(id) on delete set null,
  asked_at        timestamptz not null default now()
);

CREATE INDEX IF NOT EXISTS idx_rep_questions_rep ON rep_questions (rep_id, asked_at DESC);
CREATE INDEX IF NOT EXISTS idx_rep_questions_outcome ON rep_questions (outcome, asked_at DESC);
-- For miner clustering: case-insensitive trigram index on normalized
CREATE INDEX IF NOT EXISTS idx_rep_questions_normalized_trgm
  ON rep_questions USING gin (normalized gin_trgm_ops);

CREATE TABLE IF NOT EXISTS canonical_onboarding_topics (
  id              uuid primary key default gen_random_uuid(),
  question        text not null,                -- the canonical question text shown to new reps
  answer          text not null,                -- Leon's approved answer (front-loaded to new reps)
  source_learning_ids uuid[] default '{}',      -- helper_learnings rows this topic was built from
  n_reps_asked    integer not null default 0,   -- distinct reps that have asked this in the window
  first_seen_at   timestamptz,                  -- when the FIRST rep asked this
  promoted_at     timestamptz not null default now(),  -- when admin approved
  promoted_by_rep_id integer null references sales_reps(id) on delete set null,
  -- Display ordering on new-rep welcome card
  display_order   integer not null default 100,
  active          boolean not null default true,
  notes           text                          -- admin's own notes / hedges
);

CREATE INDEX IF NOT EXISTS idx_canonical_topics_active
  ON canonical_onboarding_topics (active, display_order)
  WHERE active = true;

-- Track which canonical topics each rep has already been shown so we
-- don't re-spam them every session.
CREATE TABLE IF NOT EXISTS canonical_topic_views (
  rep_id     integer not null references sales_reps(id) on delete cascade,
  topic_id   uuid not null references canonical_onboarding_topics(id) on delete cascade,
  shown_at   timestamptz not null default now(),
  primary key (rep_id, topic_id)
);

-- RPC: find rep_questions whose normalized text is trigram-similar
-- to a target string above a threshold. Used by the curriculum miner
-- to cluster questions without pulling them all into memory.
CREATE OR REPLACE FUNCTION rep_questions_similar(
  target_text text,
  threshold double precision,
  since_iso timestamptz
) RETURNS TABLE (id uuid, rep_id integer, raw_text text, normalized text, sim double precision)
LANGUAGE sql STABLE AS $$
  SELECT rq.id, rq.rep_id, rq.raw_text, rq.normalized, similarity(rq.normalized, target_text) AS sim
  FROM rep_questions rq
  WHERE rq.asked_at >= since_iso
    AND rq.normalized IS NOT NULL
    AND similarity(rq.normalized, target_text) >= threshold
  ORDER BY sim DESC
  LIMIT 200;
$$;

NOTIFY pgrst, 'reload schema';
