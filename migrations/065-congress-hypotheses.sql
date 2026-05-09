-- 065-congress-hypotheses.sql
-- ════════════════════════════════════════════════════════════════════
-- 1. SCHEMA CHANGE
-- New table congress_hypotheses for the hypothesis-driven loop.
--
-- Each row is a hypothesis the congress generated from data + qualitative
-- reasoning ("Tsinghua replied less than PKU last month — possibly the
-- school_pitch's name-dropping is awkward when sent to top-3 CN schools
-- since they don't need that signal"). The congress proposes a template
-- mutation to test, A/B runs in production, and the next congress run
-- reads outcomes to mark confirmed/refuted.
--
-- Lifecycle: proposed → testing → (confirmed | refuted | abandoned)
--
-- 2. WHO WRITES?
-- - src/lib/congress-runners.ts:runHypothesisCongress writes new
--   hypotheses (status='proposed'); when it picks one to test, marks
--   status='testing' + stamps proposed_template_id.
-- - The next runHypothesisCongress run examines testing hypotheses,
--   pulls outcome data (sends/replies/wechat for the proposal template
--   vs baseline), and writes status='confirmed' | 'refuted' with
--   outcome_evidence jsonb capturing the data.
--
-- 3. WHO READS?
-- - The congress runner itself (history-aware reasoning in next round)
-- - Future /admin/congress page (out of scope this PR — admin can read
--   via DB or via admin_inbox idea rows mirrored from these hypotheses)
--
-- 4. BACKFILL
-- (a) Empty at start. Forward-only — every new hypothesis the congress
--     emits creates a row.

CREATE TABLE IF NOT EXISTS congress_hypotheses (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The hypothesis itself, in plain text. ~1-3 sentences.
  hypothesis            text NOT NULL,

  -- Why we believe this. The data the analyst saw + the qualitative
  -- reasoning. Free-form text, can be multi-paragraph.
  reasoning             text NOT NULL,

  -- Which segment this hypothesis is about. {geo, school_tier,
  -- school_name, province, city} as applicable. NULL keys = N/A.
  segment               jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Lifecycle. Status check enforced at write time.
  status                text NOT NULL DEFAULT 'proposed'
                          CHECK (status IN ('proposed','testing','confirmed','refuted','abandoned')),

  -- The template proposal we generated to test this hypothesis. Set
  -- when status flips to 'testing'. NULL while only proposed.
  proposed_template_id  uuid REFERENCES email_templates(id),

  -- The baseline template we expect the proposal to beat. Used by the
  -- outcome-evaluator to know what to compare against.
  baseline_template_id  uuid REFERENCES email_templates(id),

  -- Outcome evidence as a jsonb blob. Structure depends on what the
  -- analyst pulled — typically:
  --   { sample_proposal: int, sample_baseline: int,
  --     metric: 'click_rate' | 'reply_rate' | 'wechat_rate',
  --     value_proposal: float, value_baseline: float,
  --     window_start: iso, window_end: iso }
  outcome_evidence      jsonb,

  -- Provenance.
  congress_run_id       text,
  generated_at          timestamptz NOT NULL DEFAULT now(),
  last_tested_at        timestamptz,
  decided_at            timestamptz
);

-- Active hypotheses (anything not in a terminal state) — most common
-- query when the next congress run starts up.
CREATE INDEX IF NOT EXISTS congress_hypotheses_active_idx
  ON congress_hypotheses (status, generated_at DESC)
  WHERE status IN ('proposed','testing');

-- Cross-reference back to the proposal template — useful when admin
-- approves/rejects a template proposal and we want to update the
-- linked hypothesis lifecycle.
CREATE INDEX IF NOT EXISTS congress_hypotheses_proposal_idx
  ON congress_hypotheses (proposed_template_id)
  WHERE proposed_template_id IS NOT NULL;
