-- migrations/032-emails-template-id.sql
--
-- 1. SCHEMA CHANGE
-- Adds emails.template_id (uuid, FK -> email_templates.id, nullable
-- with set-null on delete). Records WHICH template was active when
-- each draft was generated, so /api/templates/performance can
-- compute per-template send/click/wechat stats without guessing
-- via timestamp windows.
--
-- 2. WHO WRITES THIS?
-- src/lib/email-generator.ts generateDraft() now returns the
-- selected template id alongside {subject, html}; the three send
-- paths (pipeline/send, pipeline/batch-send, send) write it into
-- the emails insert.
--
-- 3. WHO READS THIS?
-- src/app/api/templates/performance/route.ts joins emails.template_id
-- to email_history (was_clicked / was_bounced) and brief_lookups
-- (added_wechat) to surface per-template performance.
--
-- 4. BACKFILL FOR OLD ROWS
-- (a) one-shot UPDATE inline below — for legacy rows we use today's
-- "effective template per rep_id" as a heuristic backfill: rep_id
-- maps to the active per-rep override, else to the global. This is
-- approximate (templates may have been swapped mid-history) but
-- better than NULL for the performance comparison.
--
-- Reference: docs/DATA_INTEGRITY_PLAN.md Tier 4

alter table emails
  add column if not exists template_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'emails'::regclass
      and conname = 'emails_template_id_fkey'
  ) then
    alter table emails
      add constraint emails_template_id_fkey
      foreign key (template_id) references email_templates(id) on delete set null;
  end if;
end $$;

create index if not exists idx_emails_template_id
  on emails (template_id) where template_id is not null;

-- Heuristic backfill: per-rep active template wins, else global.
update emails e
set    template_id = t.id
from   email_templates t
where  e.template_id is null
  and  e.rep_id is not null
  and  t.rep_id = e.rep_id
  and  t.active = true;

update emails e
set    template_id = t.id
from   email_templates t
where  e.template_id is null
  and  t.rep_id is null
  and  t.name = 'global'
  and  t.active = true;

notify pgrst, 'reload schema';
