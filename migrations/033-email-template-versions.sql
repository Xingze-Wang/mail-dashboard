-- migrations/033-email-template-versions.sql
--
-- 1. SCHEMA CHANGE
-- New table email_template_versions: snapshot of an email_templates
-- row at a point in time. Plus a trigger that fires on UPDATE to
-- copy the OLD row into the history table before the update lands.
--
-- 2. WHO WRITES THIS?
-- Trigger trg_email_templates_version_capture (in this migration)
-- captures the pre-update snapshot. No application code writes
-- directly — keeps the contract single-source.
--
-- 3. WHO READS THIS?
-- src/app/api/email-templates/[id]/versions/route.ts (GET) returns
-- the history for one template, newest first. Restore endpoint
-- copies a chosen snapshot back into email_templates.
--
-- 4. BACKFILL FOR OLD ROWS
-- (d) not applicable — new table; legacy edits aren't recoverable
-- and that's acceptable. History starts now.
--
-- Reference: docs/DATA_INTEGRITY_PLAN.md Tier 4

create table if not exists email_template_versions (
  id          uuid primary key default gen_random_uuid(),
  template_id uuid not null references email_templates(id) on delete cascade,
  snapshot    jsonb not null,
  edited_by   text,
  edited_at   timestamptz not null default now(),
  note        text
);

create index if not exists idx_email_template_versions_template
  on email_template_versions (template_id, edited_at desc);

-- Trigger: on every UPDATE, snapshot the OLD row into the history
-- table. Captures rep_id/name/active/all formats + intro_prompt +
-- notes. INSERT skipped (no prior version exists) — first edit
-- creates the first history entry.
create or replace function capture_email_template_version()
returns trigger as $$
begin
  insert into email_template_versions (template_id, snapshot, edited_at)
  values (
    OLD.id,
    jsonb_build_object(
      'name', OLD.name,
      'rep_id', OLD.rep_id,
      'active', OLD.active,
      'subject_format', OLD.subject_format,
      'intro_prompt', OLD.intro_prompt,
      'greeting_format', OLD.greeting_format,
      'rep_intro_format', OLD.rep_intro_format,
      'school_pitch_format', OLD.school_pitch_format,
      'cta_signoff_format', OLD.cta_signoff_format,
      'notes', OLD.notes
    ),
    OLD.updated_at
  );
  return NEW;
end;
$$ language plpgsql;

drop trigger if exists trg_email_templates_version_capture on email_templates;
create trigger trg_email_templates_version_capture
  before update on email_templates
  for each row
  execute function capture_email_template_version();

notify pgrst, 'reload schema';
