-- 063-email-ratings.sql
-- ════════════════════════════════════════════════════════════════════
-- 1. SCHEMA CHANGE
--    New table email_ratings: per-email score from a rater. One row
--    per (email_id, rater_kind). Designed for a 1-5 numeric score
--    plus free-text reasoning (the "why" the user wants — not just
--    numbers).
--
--    Two raters today:
--      'human' — the rep who sent (or admin reviewing a sent email),
--                stars in /pipeline post-send sheet
--      'ai'    — Gemini called with (resolved prompt, intro output,
--                recipient profile) → 1-5 + reasoning
--
--    Future raters could be 'rep_recipient' (the customer's response
--    text scored), 'self_critique' (the LLM rating its own output).
--    rater_kind is text, not enum, for forward-compat.
--
-- 2. WHO WRITES?
--    - 'human' rows: a future POST /api/emails/[id]/rate from the
--      rep-facing UI (post-send modal "rate this email 1-5").
--    - 'ai' rows: POST /api/emails/[id]/ai-rate (admin/cron) or batch
--      cron /api/cron/rate-emails. Idempotent via the unique index;
--      re-running just refreshes score/reasoning.
--
-- 3. WHO READS?
--    - /admin/template-insights: groups by template_id, computes
--      mean(score) per (template, rater_kind, segment), surfaces
--      human-vs-AI agreement gaps.
--    - Predictor training (later): joins email_ratings to
--      webhook_events to ground "what predicts open/click" signals.
--
-- 4. BACKFILL
--    Empty table at start. AI ratings can be backfilled retroactively
--    from emails.intro_prompt_resolved + intro_output (where present).
--    Human ratings are always forward-only (we never had them before).

-- emails.id type is text in this schema (string-formatted uuid), so the
-- FK column matches that. ON DELETE CASCADE keeps ratings pruned when
-- an email row is deleted (rare; mostly for test cleanup).
CREATE TABLE IF NOT EXISTS email_ratings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id    text NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  rater_kind  text NOT NULL,        -- 'human' | 'ai' | future kinds
  rater_id    int  REFERENCES sales_reps(id),  -- for 'human', who rated
  score       int  NOT NULL CHECK (score BETWEEN 1 AND 5),
  reasoning   text,                  -- the "why" — required for AI, optional for human
  model_id    text,                  -- for 'ai': which model produced the rating
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- One row per (email, rater_kind). Re-rating same email by same kind
-- updates the existing row (POST handler should UPSERT).
CREATE UNIQUE INDEX IF NOT EXISTS email_ratings_email_kind_uniq
  ON email_ratings (email_id, rater_kind);

-- Lookups by template (joined through emails.template_id) + rater_kind
-- are the most common analytics query.
CREATE INDEX IF NOT EXISTS email_ratings_email_idx
  ON email_ratings (email_id);
CREATE INDEX IF NOT EXISTS email_ratings_kind_idx
  ON email_ratings (rater_kind, created_at DESC);
