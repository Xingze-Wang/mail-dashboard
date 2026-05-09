-- 069-template-edits.sql
-- ════════════════════════════════════════════════════════════════════
-- 1. SCHEMA CHANGE
-- New table template_edits: a soft-edit / diff queue for changes to
-- email_templates. Sales reps submit edits here; admins approve in a
-- review UI; only on approve does the change merge into the live
-- template row.
--
-- This solves three things at once:
--   - sales reps can author + propose template changes without ever
--     mutating production-routing rows
--   - the AI editor gate runs at submit time and stores its annotations
--     ALONGSIDE the diff, so admin reviewers see "the gate flagged the
--     intro_prompt as too 销售腔" before they merge
--   - amends history: every edit ever attempted is preserved with
--     who-submitted-when-with-what-verdict, so we can later train on
--     "edits humans approved despite gate revise" patterns
--
-- Status flow:
--   pending   — submitted, awaiting admin review
--   approved  — admin merged into the live template row
--   rejected  — admin declined; review_note explains why
--   superseded — a newer pending edit on the same (template, slot)
--               replaced this one (auto-set when a fresh submit arrives
--               for the same slot)
--
-- 2. WHO WRITES
--   - POST /api/templates/[id]/edits (any rep) — creates a pending row
--   - POST /api/admin/template-edits/[edit_id]/approve (admin only) —
--     sets status='approved', merges new_value into email_templates,
--     stamps reviewed_by_rep_id + reviewed_at
--   - POST /api/admin/template-edits/[edit_id]/reject (admin only) —
--     sets status='rejected' + review_note
--
-- 3. WHO READS
--   - /admin/template-edits — pending queue, all templates
--   - /templates/[id]/edit — shows pending edits for this template
--     so the rep can see their submission and its gate verdict
--   - /templates/[id]/inspect — shows recent approved edits as
--     "change history" footer
--
-- 4. BACKFILL
--   Empty at start. Existing templates aren't backfilled with synthetic
--   edits — the diff queue is forward-only.
--
-- IMPORTANT
--   Active templates can ONLY be edited via this queue (no in-place
--   PATCH for active). For proposal/approved_draft, an admin editing
--   directly is still allowed (their edit is its own approval) — the
--   queue is the path for non-admins, or for admins who want a peer
--   review.

CREATE TABLE IF NOT EXISTS template_edits (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id       uuid NOT NULL REFERENCES email_templates(id) ON DELETE CASCADE,

  -- Which slot is being edited. Constrained to the 7 editable surfaces
  -- (the 6 prose slots + segment_default + notes).
  slot_key          text NOT NULL CHECK (slot_key IN (
    'subject_format', 'intro_prompt', 'greeting_format',
    'rep_intro_format', 'school_pitch_format', 'cta_signoff_format',
    'segment_default', 'notes'
  )),

  -- Old + new value snapshots so the diff is self-contained even if
  -- the template later gets edited again (we don't want to recompute
  -- the diff against a moving target).
  old_value         text,
  new_value         text,

  -- Gate output at submission time. verdict ∈ {pass, revise, reject, error}
  -- annotations is the full editor JSON (issues array, dim scores, etc.)
  -- so the admin reviewer sees the gate's reasoning, not just the verdict.
  gate_verdict      text CHECK (gate_verdict IN ('pass', 'revise', 'reject', 'error')),
  gate_annotations  jsonb,

  -- Status lifecycle. See header comment.
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),

  submitted_by_rep_id  int NOT NULL REFERENCES sales_reps(id),
  submitted_at         timestamptz NOT NULL DEFAULT now(),

  reviewed_by_rep_id   int REFERENCES sales_reps(id),
  reviewed_at          timestamptz,
  review_note          text,

  -- Optional rep-supplied rationale. ("我觉得 cn 群体对'同行'更有感觉,
  -- 所以把 'researcher' 换成 '同学'") — helps reviewer + future training.
  rep_rationale     text,

  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS template_edits_template_idx
  ON template_edits (template_id, status, submitted_at DESC);

CREATE INDEX IF NOT EXISTS template_edits_pending_idx
  ON template_edits (status, submitted_at DESC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS template_edits_submitter_idx
  ON template_edits (submitted_by_rep_id, submitted_at DESC);
