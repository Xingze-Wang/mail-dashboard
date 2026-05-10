-- 077-insights-llm-cache-and-congress-chime.sql
-- ════════════════════════════════════════════════════════════════════
-- 1. SCHEMA CHANGE
--
-- Two related additions, batched because they share the daily cron:
--
-- (A) insights_llm_cache: cached output of GET /api/insights so the
--     /analysis page renders instantly. The existing insights_snapshots
--     table caches per-DIMENSION funnel cuts (geo_binary, school_tier,
--     etc.) for /analysis/cut/[dim]. THIS table caches the per-USER
--     LLM-curated landing page payload — keyed by (rep_id|null, role).
--     Different access pattern, deliberately not the same table.
--
-- (B) helper_chime_in_log: append-only history of every chime-in we've
--     pushed to a rep, so a "congress chimes in" message doesn't fire
--     for the same proposal twice. The existing
--     helper_rep_state.pending_chime_in is one-slot — it's the active
--     pull-queue. This new table is the audit log so the daily cron
--     can ask "did we already chime this rep about proposal X?".
--
-- 2. WHO WRITES
--   - GET /api/cron/insights-prewarm (NEW; daily ~06:15 UTC, after
--     insights-realign at 06:00 so it sees today's snapshots).
--     Computes the LLM payload for each (rep, role) and writes here.
--   - GET /api/insights itself, on cache miss: writes the freshly-
--     computed payload back to the cache so the SECOND visitor that
--     day gets the fast path.
--   - GET /api/cron/congress-chime (NEW; daily 07:30 UTC) writes both
--     pending_chime_in (active queue) and helper_chime_in_log (audit).
--
-- 3. WHO READS
--   - GET /api/insights — checks insights_llm_cache for today's row
--     for this (rep, role) tuple; if hit, return immediately. If miss,
--     fall through to live LLM compute and write-through.
--   - GET /api/help/chime-in — already reads from
--     helper_rep_state.pending_chime_in. The chime-in log is admin-only
--     (debugging "did the cron really fire?").
--
-- 4. BACKFILL
--   Empty at start. The first GET /api/insights after deploy will be
--   slow (live LLM, ~5-15s) and write the cache row; subsequent
--   visits same day are instant. The 06:15 cron pre-warms before
--   the user logs in.
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS insights_llm_cache (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Scope. NULL rep_id = admin/org-wide view. Non-null = per-rep.
  -- role disambiguates an admin who is also a rep (rare but possible)
  -- between "I want my numbers" vs "I want the org view".
  rep_id          int  REFERENCES sales_reps(id),
  role_view       text NOT NULL CHECK (role_view IN ('rep', 'admin')),

  -- The full InsightsPayload as JSON, ready to hand back to the
  -- client. Identical shape to what the live LLM compute returns.
  payload         jsonb NOT NULL,

  -- Bookkeeping.
  effective_date  date NOT NULL DEFAULT CURRENT_DATE,
  computed_at     timestamptz NOT NULL DEFAULT now(),
  decided_by      text NOT NULL DEFAULT 'cron'
                  CHECK (decided_by IN ('cron', 'live', 'admin')),
  decision_model  text
);

-- One active row per (rep_view, day). Same-day re-runs upsert.
-- We need TWO partial unique indexes because PostgreSQL can't put
-- NULL rep_id into a regular unique index — same trick as
-- migration 075 used for insights_snapshots.
CREATE UNIQUE INDEX IF NOT EXISTS insights_llm_cache_per_rep
  ON insights_llm_cache (rep_id, role_view, effective_date)
  WHERE rep_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS insights_llm_cache_org
  ON insights_llm_cache (role_view, effective_date)
  WHERE rep_id IS NULL;

-- Hot path: page asks "today's row for me".
CREATE INDEX IF NOT EXISTS insights_llm_cache_lookup
  ON insights_llm_cache (rep_id, role_view, effective_date DESC);


-- ─── (B) helper_chime_in_log ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS helper_chime_in_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id          int NOT NULL REFERENCES sales_reps(id),

  -- Discriminator. "voice_capture_offer" is the existing kind.
  -- "congress_proposal_review" is the new one this migration enables:
  -- after weekly Tactical Congress fires, ask each rep "we proposed
  -- swapping X — does this match what you've seen?"
  kind            text NOT NULL,

  -- The chime-in payload that was actually pushed. Same shape as
  -- helper_rep_state.pending_chime_in.
  payload         jsonb NOT NULL,

  -- Optional FK to whatever this chime-in is about. For congress, this
  -- points at a tactical_proposals.id or email_templates.id (the
  -- proposal being asked about). NULL for type=voice_capture_offer.
  ref_kind        text,                         -- 'tactical_proposal'|'email_template'|null
  ref_id          uuid,

  -- Outcome. Filled when the rep dismisses or replies; NULL means
  -- still active.
  outcome         text CHECK (outcome IN ('replied', 'dismissed', 'expired') OR outcome IS NULL),
  outcome_at      timestamptz,

  -- Bookkeeping.
  pushed_at       timestamptz NOT NULL DEFAULT now()
);

-- "Did we already chime this rep about proposal X?" — partial index
-- because most pushes are NOT congress-related.
CREATE INDEX IF NOT EXISTS helper_chime_in_log_rep_ref
  ON helper_chime_in_log (rep_id, ref_kind, ref_id)
  WHERE ref_kind IS NOT NULL;

-- Telemetry: "show me last week's chime-ins for this rep".
CREATE INDEX IF NOT EXISTS helper_chime_in_log_rep_recency
  ON helper_chime_in_log (rep_id, pushed_at DESC);
