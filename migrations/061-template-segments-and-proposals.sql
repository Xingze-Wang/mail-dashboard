-- migrations/061-template-segments-and-proposals.sql
--
-- 1. SCHEMA CHANGE
-- Five columns added to email_templates so each row can carry:
--   - segment_default (text)  — 'cn' | 'overseas' | 'fallback' | 'strong' | 'weak' | NULL
--                               When set, this template is the default
--                               for that segment (used by the future
--                               segment-aware loadEffectiveTemplate).
--   - status (text)           — 'active' | 'proposal' | 'archived'
--                               Default 'active'. 'proposal' rows are
--                               drafts (e.g. from congress) waiting
--                               for admin review; loadEffectiveTemplate
--                               IGNORES proposals + archived.
--   - proposed_by (text)      — 'congress' | 'admin' | 'leon' | NULL
--                               Provenance for proposals.
--   - proposed_reason (text)  — One-paragraph justification ("based on
--                               412 sends, reply rate 7.2% vs 12.3%, ...").
--                               Required when status='proposal'.
--   - proposed_evidence (jsonb) — Structured backing data: {
--                                  sample_size, baseline_template_id,
--                                  baseline_metric, proposed_metric,
--                                  date_range, ... }. Optional but
--                                  encouraged. Bench/admin-inbox UI
--                                  surfaces these directly.
--
-- 2. WHO WRITES THIS?
--   - segment_default: admins editing on /templates page.
--   - status='proposal' rows: congress workers + Leon (helper-tools);
--     stay 'proposal' until an admin POSTs to /api/templates/[id]/promote.
--   - proposed_*: only set on 'proposal' rows by whatever creates them.
--
-- 3. WHO READS THIS?
--   - src/lib/template-assembler.ts loadEffectiveTemplate: filter
--     status='active' (NOT 'proposal' or 'archived'). When a future
--     "segment-aware" mode lands, it will also filter by segment_default.
--   - /admin/inbox extension: surface proposal rows so admin can
--     promote/dismiss with one click.
--   - /templates/bench: shows segment_default badge per template.
--
-- 4. BACKFILL FOR OLD ROWS
-- (a) DEFAULT 'active' for status fills NULLs — every existing row
--     becomes status='active', preserving current behavior. The single
--     'global' row keeps working unchanged.
-- (b) segment_default left NULL on existing rows — meaning "no segment
--     preference, use as catch-all". The current 'global' template
--     SHOULD be left at NULL so it remains the universal fallback
--     until admin explicitly assigns segments to other templates.

ALTER TABLE email_templates
  ADD COLUMN IF NOT EXISTS segment_default   text,
  ADD COLUMN IF NOT EXISTS status            text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS proposed_by       text,
  ADD COLUMN IF NOT EXISTS proposed_reason   text,
  ADD COLUMN IF NOT EXISTS proposed_evidence jsonb;

-- Validate enum-ish status. Defensive — a typo in code that wrote
-- status='proposed' (instead of 'proposal') would otherwise silently
-- create a row that no read path looks for.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'email_templates_status_check'
  ) THEN
    ALTER TABLE email_templates
      ADD CONSTRAINT email_templates_status_check
      CHECK (status IN ('active', 'proposal', 'archived'));
  END IF;
END $$;

-- Lookup index for segment-aware reads. Partial index on active rows
-- because that's the only status loadEffectiveTemplate cares about.
CREATE INDEX IF NOT EXISTS idx_email_templates_segment_active
  ON email_templates (segment_default)
  WHERE status = 'active' AND active = true;

-- Lookup index for proposal review (admin inbox / proposals page).
CREATE INDEX IF NOT EXISTS idx_email_templates_proposals
  ON email_templates (created_at DESC)
  WHERE status = 'proposal';
