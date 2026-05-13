-- migrations/083-email-template-overrides.sql
--
-- 1. SCHEMA CHANGE
-- Adds two nullable columns on email_templates:
--   full_html_override TEXT
--   subject_override TEXT
-- When set, template-assembler renders the entire body/subject from
-- these directly instead of stitching slots. Lets us materialize a
-- rep's full edited HTML as a template verbatim.
--
-- 2. WHO WRITES THIS?
-- /api/cron/rep-edit-clustering writes when it materializes a
-- per-rep template from a cluster of similar edits. Also written
-- by /api/admin/templates/candidates POST when admin clones a per-rep
-- template into a global proposal (copies the override fields too).
--
-- 3. WHO READS THIS?
-- src/lib/template-assembler.ts — assembleDraft(); if non-null, the
-- override is used and slot-based rendering is skipped for that field.
--
-- 4. BACKFILL FOR OLD ROWS
-- (c) intentionally NULL for legacy templates — they continue to
-- render via slot-based stitching. No backfill needed.

ALTER TABLE email_templates
  ADD COLUMN IF NOT EXISTS full_html_override TEXT,
  ADD COLUMN IF NOT EXISTS subject_override TEXT;
