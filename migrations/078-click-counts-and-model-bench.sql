-- 078-click-counts-and-model-bench.sql
-- ════════════════════════════════════════════════════════════════════
-- 1. SCHEMA CHANGE
--
-- Three coordinated additions:
--
-- (A) pipeline_leads.click_count + brief_lookups.click_count
--     Denormalized count of distinct click events per (lead, person).
--     We already have webhook_events as authoritative event log; this
--     is the rolled-up integer for fast read in scorer / list views.
--     Multiple clicks on the same email = stronger interest signal
--     than one click. Today's funnel logic only sees yes/no.
--
-- (B) model_prompts table
--     A leaderboard of competing prompt variants for each prediction
--     model. kind = 'persona_recipient' | 'email_quality_judge' |
--     'ctr_regressor'. A prompt is a row; the cron evaluates each
--     prompt against the held-out backtest set; we keep the winner.
--
-- (C) model_predictions table
--     Append-only log of every (prompt × target) prediction. target
--     can be an email_id (Models 1, 3) or template_id (Model 2). The
--     ground-truth join (did they click? did admin approve?) happens
--     at read time on /admin/model-bench so we can recompute
--     calibration as fresh data arrives without rewriting old rows.
--
-- 2. WHO WRITES
--   - GET /api/cron/model-bench-eval (NEW; daily 08:00 UTC) loops
--     over active model_prompts rows, runs each against last-30d
--     held-out targets that don't have a prediction from this prompt
--     yet, writes results to model_predictions.
--   - POST /api/admin/model-prompts (NEW) — admin adds a new prompt
--     candidate to the leaderboard.
--
-- 3. WHO READS
--   - GET /admin/model-bench (NEW page) — shows per-kind leaderboard:
--     prompts ranked by calibration / AUC / agreement-with-admin.
--   - The lead scorer / template assembler — Phase 2, after we
--     pick winners, those scores can gate sends.
--
-- 4. BACKFILL
--   - Click counts: backfill via existence-check on webhook_events,
--     deduped on (event_id) since Resend redelivers occasionally.
--     Same paginate-all pattern as DATA_INTEGRITY_PLAN.md mandates.
--   - Model bench: empty at start. The first eval cron run
--     populates today's predictions for whatever prompts exist.
-- ════════════════════════════════════════════════════════════════════

-- ─── (A) Click counts ──────────────────────────────────────────────

ALTER TABLE pipeline_leads
  ADD COLUMN IF NOT EXISTS click_count int NOT NULL DEFAULT 0;

ALTER TABLE pipeline_leads
  ADD COLUMN IF NOT EXISTS last_click_at timestamptz;

-- brief_lookups.click_count is per-person (since one person can have
-- multiple emails sent over the lifetime of the dashboard). Useful
-- when surfacing "this person has been clicking your stuff" in
-- /pipeline list view, separate from the per-lead count above.
ALTER TABLE brief_lookups
  ADD COLUMN IF NOT EXISTS click_count int NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS pipeline_leads_click_count
  ON pipeline_leads (click_count DESC)
  WHERE click_count > 0;

-- ─── (B) Model prompts leaderboard ─────────────────────────────────

CREATE TABLE IF NOT EXISTS model_prompts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Which of the three prediction families this prompt belongs to.
  -- Keep the strings aligned with the route handler so a typo
  -- doesn't silently route to the wrong evaluator.
  kind            text NOT NULL CHECK (kind IN (
                    'persona_recipient',     -- Model 1: would this persona click/apply?
                    'email_quality_judge',   -- Model 2: AI judge of new template proposals
                    'ctr_regressor'          -- Model 3: pure P(click) prediction
                  )),

  -- Human-readable label for the leaderboard. e.g. "junior-phd-strict-v3"
  -- or "tier1-faculty-warm-v1".
  name            text NOT NULL,

  -- Optional persona archetype for Model 1 prompts. NULL for Model 2/3.
  -- e.g. 'junior_phd_tier1', 'senior_pi_tier2', 'industry_researcher'.
  -- The archetype determines which leads this prompt is evaluated
  -- against (we only test the SJTU-PhD prompt on actual SJTU-PhD-shaped
  -- leads, not on senior PIs).
  persona_archetype text,

  -- The actual system prompt the LLM sees. Lots of room because
  -- evidence-rich prompts are the whole point of the leaderboard.
  system_prompt   text NOT NULL,

  -- Which model to call. Lets us A/B Gemini vs Claude vs GPT for
  -- the same prompt body — sometimes the model matters more than the
  -- words. Default is gemini-2.5-flash because Gemini is fastest +
  -- cheapest for the volume we'll generate.
  llm_model       text NOT NULL DEFAULT 'gemini-2.5-flash',

  -- Lifecycle.
  active          boolean NOT NULL DEFAULT true,
  created_by_rep_id int REFERENCES sales_reps(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  notes           text,                       -- why we made this variant
  archived_at     timestamptz,
  archived_reason text                        -- "lost to v2" / "calibration too flat"
);

CREATE INDEX IF NOT EXISTS model_prompts_active
  ON model_prompts (kind, active, created_at DESC)
  WHERE active = true;

-- ─── (C) Model predictions append-only log ─────────────────────────

CREATE TABLE IF NOT EXISTS model_predictions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  prompt_id       uuid NOT NULL REFERENCES model_prompts(id) ON DELETE CASCADE,
  kind            text NOT NULL,                -- denormalized from prompt for fast filter

  -- Target. Exactly one of these is set — Models 1/3 predict on
  -- emails, Model 2 predicts on templates. Polymorphic columns
  -- avoid a TEXT discriminator that's easier to typo.
  -- Note: emails.id is text (legacy, not uuid), email_templates.id
  -- is uuid. Type each FK to match its parent.
  email_id        text REFERENCES emails(id) ON DELETE CASCADE,
  template_id     uuid REFERENCES email_templates(id) ON DELETE CASCADE,

  -- The structured prediction. Shape varies by kind:
  --   persona_recipient  : {p_click: 0..1, p_apply: 0..1, reasoning: text}
  --   email_quality_judge: {craft_score: 1..5, voice_score: 1..5,
  --                         segment_fit: 1..5, would_approve: bool, reasoning}
  --   ctr_regressor      : {p_click: 0..1, reasoning: text}
  prediction      jsonb NOT NULL,

  -- The pre-flattened key prediction so leaderboards can ORDER BY
  -- and bucket without parsing JSONB on every read. For Model 2,
  -- the headline is would_approve (cast bool→1/0); for 1 and 3,
  -- it's p_click.
  headline        numeric,

  -- Bookkeeping.
  predicted_at    timestamptz NOT NULL DEFAULT now(),
  llm_model       text,
  llm_latency_ms  int,
  prompt_version_hash text,                    -- sha256 of system_prompt at predict time

  -- Optional outcome snapshot. Filled by the bench page lazily so
  -- we never need to backfill — it computes calibration from raw
  -- ground truth (emails.clicked_at, brief_lookups.added_wechat,
  -- email_templates.status) at read time.
  CONSTRAINT one_target CHECK (
    (email_id IS NOT NULL AND template_id IS NULL) OR
    (email_id IS NULL AND template_id IS NOT NULL)
  )
);

-- One prediction per (prompt × target). Lets the eval cron be
-- idempotent — re-running it skips already-predicted pairs.
CREATE UNIQUE INDEX IF NOT EXISTS model_predictions_email_unique
  ON model_predictions (prompt_id, email_id)
  WHERE email_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS model_predictions_template_unique
  ON model_predictions (prompt_id, template_id)
  WHERE template_id IS NOT NULL;

-- Hot path: bench page asks "give me last-30d predictions for this
-- prompt, joined with ground truth".
CREATE INDEX IF NOT EXISTS model_predictions_lookup
  ON model_predictions (kind, predicted_at DESC);

CREATE INDEX IF NOT EXISTS model_predictions_email
  ON model_predictions (email_id, kind)
  WHERE email_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS model_predictions_template
  ON model_predictions (template_id, kind)
  WHERE template_id IS NOT NULL;
