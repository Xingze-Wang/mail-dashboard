-- 062-emails-prompt-output.sql
-- ════════════════════════════════════════════════════════════════════
-- 1. SCHEMA CHANGE
--    Two columns added to `emails`:
--      - intro_prompt_resolved text — the FULL Gemini prompt with all
--        {{title}}, {{abstract}} substitutions applied. This is what
--        was actually fed to the model. Used to analyze "which prompt
--        phrasings produce which output styles" + ML training signal.
--      - intro_output text — the raw LLM-generated personalized intro
--        sentence (post-sanitize, pre-HTML-escape). Distinct from
--        emails.html which has the wrapper. Lets us train predictors
--        on the AI-generated chunk in isolation.
--
-- 2. WHO WRITES?
--    src/lib/template-assembler.ts:assembleDraft will now thread the
--    resolved prompt + output up through the call chain so the send
--    routes can stamp them onto emails at insert time. Optional fields
--    (NULL if generation failed or fell through legacy path).
--
-- 3. WHO READS?
--    - /admin/template-insights (future) — predictor + why-explainer
--      reads (intro_prompt_resolved, intro_output, recipient_profile)
--      → P(open), P(click), reasoning.
--    - Two-sided rating flow — AI rater reads intro_output + recipient
--      profile, returns 1-5 score.
--    - Bench page already shows rendered output; can later show the
--      RESOLVED prompt that produced it on click (task 33).
--
-- 4. BACKFILL
--    Both columns nullable + default null. Existing rows: NULL means
--    "we didn't capture this at send time" — analytics queries should
--    skip them. ~1400 historical emails will have NULL; new sends
--    forward will be populated.

ALTER TABLE emails
  ADD COLUMN IF NOT EXISTS intro_prompt_resolved text,
  ADD COLUMN IF NOT EXISTS intro_output text;

-- Mirror columns on pipeline_leads — captured at draft creation time
-- (scan / import / draft-queue) so the send route can read them off
-- the lead row instead of trying to re-extract from rendered html.
-- This keeps the prompt/output as a single source of truth that
-- survives reassignment unchanged (it's lead-bound, not rep-bound).
ALTER TABLE pipeline_leads
  ADD COLUMN IF NOT EXISTS draft_intro_prompt_resolved text,
  ADD COLUMN IF NOT EXISTS draft_intro_output text;

-- Index on (template_id, created_at) is already useful for analytics;
-- no new index here. Adding one on intro_output would be wasteful —
-- it's free-form text, not filterable.
