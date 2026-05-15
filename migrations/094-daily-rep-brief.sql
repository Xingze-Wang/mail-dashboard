-- Migration 094: daily_rep_brief — one nightly LLM-written narrative
-- per rep per day. Surfaced on /missions as the "today's focus" block.
--
-- 1. SCHEMA CHANGE
--   - daily_rep_brief: (rep_id, brief_date) unique. Contains the
--     LLM-generated goal sentence + 2-3 supporting bullets + a
--     reasoning rationale (why this is today's focus given the
--     data). Optional jitr_signal — if true, the cron believes
--     this needs admin attention before rep sees it (gated rollout).
--
-- 2. WHO WRITES
--   - /api/cron/daily-rep-brief — runs nightly ~04:30 UTC after
--     insights-realign + insights-prewarm so it reads coherent data
--   - admin can edit via /admin/missions (TODO; for now read-only
--     reps + admin both)
--
-- 3. WHO READS
--   - /missions page top block ("Today" surface)
--   - bot's get_my_missions_today tool (extended)
--
-- 4. BACKFILL
--   - None. Forward-only.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS daily_rep_brief (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id        int  NOT NULL REFERENCES sales_reps(id) ON DELETE CASCADE,
  brief_date    date NOT NULL,

  goal          text NOT NULL,                  -- one-sentence "today, do X"
  reasoning     text NOT NULL,                  -- 2-3 sentence why
  bullets       jsonb NOT NULL DEFAULT '[]'::jsonb,  -- ["watch out for Y", "leverage Z", ...]

  decision_model text,
  computed_at   timestamptz NOT NULL DEFAULT now(),

  -- Editable by admin if they disagree with the LLM
  admin_overrode boolean NOT NULL DEFAULT false,
  admin_note     text,

  UNIQUE (rep_id, brief_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_rep_brief_date
  ON daily_rep_brief (brief_date DESC, rep_id);

NOTIFY pgrst, 'reload schema';
