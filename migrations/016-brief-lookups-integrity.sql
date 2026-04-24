-- ═══════════════════════════════════════════════════════════════════
-- Migration 016: brief_lookups integrity + dedup
--
-- Two real bugs surfaced by the audit:
--   1. No FK on brief_lookups.lead_id → pipeline_leads.id means a row
--      can reference a non-existent lead. WeChat counters COUNT(*) or
--      COUNT(lead_id) then inflate.
--   2. No uniqueness means repeated "Mark added on WeChat" clicks on
--      the same lead insert multiple rows, each counted once.
--
-- Fixes:
--   - FK with ON DELETE SET NULL (we want the conversion EVENT to
--     outlive a lead being deleted — useful for admin audit — but
--     the lead_id pointer should be nulled, not orphan-dangling).
--   - Partial UNIQUE INDEX on lead_id where added_wechat=true, so
--     at most one "converted" row per lead exists.
--
-- Idempotent.
-- ═══════════════════════════════════════════════════════════════════

-- FK: only add if not already present. DO block handles the absence of
-- "ADD CONSTRAINT IF NOT EXISTS" in older Postgres.
do $$ begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'fk_brief_lookups_pipeline_leads'
      and table_name = 'brief_lookups'
  ) then
    -- Clean up any orphans before the FK goes on, so the constraint
    -- add doesn't fail. Sets lead_id=null on rows whose lead has
    -- already been deleted.
    update brief_lookups
    set    lead_id = null
    where  lead_id is not null
      and  lead_id not in (select id from pipeline_leads);

    alter table brief_lookups
      add constraint fk_brief_lookups_pipeline_leads
      foreign key (lead_id) references pipeline_leads(id) on delete set null;
  end if;
end $$;

-- Dedup: for marked-wechat rows, only one per lead. Partial index so
-- historical "not yet added" rows (added_wechat=false) aren't
-- constrained. Before creating it, collapse any existing duplicates:
-- keep the OLDEST added_wechat=true row per lead, delete the rest.
with ranked as (
  select id,
         row_number() over (
           partition by lead_id
           order by wechat_at asc nulls last, id asc
         ) as rn
  from   brief_lookups
  where  added_wechat = true
    and  lead_id is not null
)
delete from brief_lookups
where id in (select id from ranked where rn > 1);

create unique index if not exists ux_brief_lookups_wechat_per_lead
  on brief_lookups (lead_id)
  where added_wechat = true and lead_id is not null;
