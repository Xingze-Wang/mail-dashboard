-- migrations/026-emails-actor-rep-id.sql
--
-- 1. SCHEMA CHANGE
-- Adds emails.actor_rep_id (int FK -> sales_reps.id) plus index. The
-- column already exists in prod (added out-of-band) — this file
-- exists so a fresh setup will have it without anyone copy-pasting
-- ad-hoc SQL. ALTER is idempotent.
--
-- 2. WHO WRITES THIS?
-- src/app/api/pipeline/send/route.ts:323
-- src/app/api/pipeline/batch-send/route.ts:260
-- src/app/api/send/route.ts:65
-- All set actor_rep_id = session.repId at insert time.
--
-- 3. WHO READS THIS?
-- Currently: nothing reads it directly yet (the column exists for
-- future "credit the actor not the owner" attribution math). The
-- canonical actor signal today still comes from session at the time
-- of the action. Keeping the column populated going forward so when
-- a consumer lands the data is already there.
--
-- 4. BACKFILL FOR OLD ROWS
-- (a) one-shot UPDATE inline below — copy rep_id (which is the
-- assigned-rep snapshot) for legacy rows where actor was the owner.
-- This is a heuristic — for rows where admin sent on behalf of
-- another rep, actor != rep_id and we have no way to recover that
-- distinction historically. Documented inline.
--
-- Reference: docs/DATA_INTEGRITY_PLAN.md Tier 4

alter table emails
  add column if not exists actor_rep_id integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'emails'::regclass
      and conname = 'emails_actor_rep_id_fkey'
  ) then
    alter table emails
      add constraint emails_actor_rep_id_fkey
      foreign key (actor_rep_id) references sales_reps(id) on delete set null;
  end if;
end $$;

create index if not exists idx_emails_actor_rep_id
  on emails (actor_rep_id) where actor_rep_id is not null;

-- Heuristic backfill: for legacy rows, assume actor = rep_id (the
-- assigned-rep at send time). This is wrong for any row where an
-- admin sent on behalf of another rep, but we have no record of
-- those overrides historically. Best we can do; new rows get the
-- correct value at insert time going forward.
update emails
set    actor_rep_id = rep_id
where  actor_rep_id is null
  and  rep_id is not null;

notify pgrst, 'reload schema';
