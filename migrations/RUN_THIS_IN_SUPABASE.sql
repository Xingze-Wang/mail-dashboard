-- ═══════════════════════════════════════════════════════════════════
-- RUN_THIS_IN_SUPABASE.sql  (v3 — self-inspects the DB)
--
-- Paste into Supabase → SQL Editor → Run.
--
-- Every block first checks whether the table(s) it depends on exist.
-- If a required table is missing the block SKIPS with a NOTICE instead
-- of crashing. This is the fix for the earlier
-- "relation helper_rep_state does not exist" error — on that DB,
-- migration 007 was never run, so every block that assumes
-- helper_rep_state was crashing. Now it just skips + tells you.
--
-- Safe to run any number of times. Idempotent. Only the blocks whose
-- prerequisites are satisfied actually execute.
--
-- What each block needs:
--   008: pipeline_leads (always present)
--        prompt_drift_patterns, lead_corrections (created if missing)
--   009: helper_rep_state        (migration 007 must exist)
--   010: (creates email_templates)
--   011: email_templates         (seeded by 010)
--   012: brief_lookups           (created by /api/setup)
--   013: helper_rep_state + helper_conversations (migration 007)
--   014: emails + inbound_emails + sales_reps  (app bootstrap)
--   015: pipeline_leads          (always present)
--   016: brief_lookups + pipeline_leads
--   017: pipeline_leads          (always present)
--   018: pipeline_leads          (always present)
-- ═══════════════════════════════════════════════════════════════════


-- ═════════════════════════════════════════════════════════════════
-- 008 — drift + edit-tracking columns + tables
-- ═════════════════════════════════════════════════════════════════

do $$
begin
  if not exists (select 1 from information_schema.tables where table_name = 'pipeline_leads') then
    raise notice '[008] SKIP — pipeline_leads does not exist. Run the app bootstrap first.';
    return;
  end if;

  alter table pipeline_leads add column if not exists draft_original_subject text;
  alter table pipeline_leads add column if not exists draft_original_html    text;
  alter table pipeline_leads add column if not exists draft_model            text;
  alter table pipeline_leads add column if not exists draft_edit_distance    integer;
  alter table pipeline_leads add column if not exists edit_reasons           text[];
  alter table pipeline_leads add column if not exists edit_note              text;
  alter table pipeline_leads add column if not exists judge_avg              real;
  alter table pipeline_leads add column if not exists judge_prompt_leak      boolean;
  alter table pipeline_leads add column if not exists judge_at               timestamptz;
  alter table pipeline_leads add column if not exists judge_verdicts         jsonb;
end $$;

create index if not exists idx_pipeline_leads_judge_edit
  on pipeline_leads (sent_at desc)
  where judge_avg is not null and draft_edit_distance is not null;

create index if not exists idx_pipeline_leads_rep_edit_sent
  on pipeline_leads (assigned_rep_id, sent_at desc)
  where draft_edit_distance is not null;


-- prompt_drift_patterns ---------------------------------------------

create table if not exists prompt_drift_patterns (
  id                uuid primary key default gen_random_uuid(),
  detected_at       timestamptz not null default now(),
  rep_id            integer,
  category          text not null,
  ai_phrase         text not null,
  sales_phrase      text,
  occurrence_count  integer not null default 1,
  example_lead_ids  text[] not null default '{}',
  prompt_patch      text,
  status            text not null default 'pending'
                    check (status in ('pending','accepted','ignored')),
  accepted_at       timestamptz,
  accepted_by       text
);

-- Back-compat: patch any column that might be missing on a
-- pre-existing prompt_drift_patterns.
alter table prompt_drift_patterns add column if not exists detected_at      timestamptz not null default now();
alter table prompt_drift_patterns add column if not exists rep_id           integer;
alter table prompt_drift_patterns add column if not exists category         text;
alter table prompt_drift_patterns add column if not exists ai_phrase        text;
alter table prompt_drift_patterns add column if not exists sales_phrase     text;
alter table prompt_drift_patterns add column if not exists occurrence_count integer not null default 1;
alter table prompt_drift_patterns add column if not exists example_lead_ids text[] not null default '{}';
alter table prompt_drift_patterns add column if not exists prompt_patch     text;
alter table prompt_drift_patterns add column if not exists status           text not null default 'pending';
alter table prompt_drift_patterns add column if not exists accepted_at      timestamptz;
alter table prompt_drift_patterns add column if not exists accepted_by      text;

create index if not exists idx_drift_patterns_status_detected
  on prompt_drift_patterns (status, detected_at desc);
create index if not exists idx_drift_patterns_rep
  on prompt_drift_patterns (rep_id);
create index if not exists idx_drift_patterns_category
  on prompt_drift_patterns (category);


-- lead_corrections --------------------------------------------------

create table if not exists lead_corrections (
  id            uuid primary key default gen_random_uuid(),
  lead_id       uuid not null,
  rep_id        integer,
  type          text not null,
  severity      text default 'soft'
                check (severity in ('soft','hard')),
  reason        text,
  payload       jsonb,
  skip          boolean default false,
  corrected_by  text,
  corrected_at  timestamptz default now(),
  created_at    timestamptz default now()
);

-- Patch in anything the pre-existing lead_corrections might be missing
-- (this was the "column created_at does not exist" error earlier).
alter table lead_corrections add column if not exists rep_id       integer;
alter table lead_corrections add column if not exists severity     text default 'soft';
alter table lead_corrections add column if not exists reason       text;
alter table lead_corrections add column if not exists payload      jsonb;
alter table lead_corrections add column if not exists skip         boolean default false;
alter table lead_corrections add column if not exists corrected_by text;
alter table lead_corrections add column if not exists corrected_at timestamptz default now();
alter table lead_corrections add column if not exists created_at   timestamptz default now();

create index if not exists idx_lead_corrections_lead
  on lead_corrections (lead_id);
create index if not exists idx_lead_corrections_created
  on lead_corrections (created_at desc);
create index if not exists idx_lead_corrections_rep
  on lead_corrections (rep_id);
create index if not exists idx_lead_corrections_type
  on lead_corrections (type);


-- ═════════════════════════════════════════════════════════════════
-- 009 — helper_rep_state.pending_chime_in
-- NEEDS migration 007 to have run first (helper_rep_state must exist)
-- ═════════════════════════════════════════════════════════════════

do $$
begin
  if not exists (select 1 from information_schema.tables where table_name = 'helper_rep_state') then
    raise notice '[009] SKIP — helper_rep_state does not exist (migration 007 not applied).';
    return;
  end if;

  alter table helper_rep_state add column if not exists pending_chime_in jsonb;
end $$;


-- ═════════════════════════════════════════════════════════════════
-- 010 — email_templates table
-- ═════════════════════════════════════════════════════════════════

create table if not exists email_templates (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null unique,
  rep_id               integer,
  active               boolean not null default true,
  subject_format       text not null,
  intro_prompt         text not null,
  greeting_format      text not null,
  rep_intro_format     text not null,
  school_pitch_format  text not null,
  cta_signoff_format   text not null,
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

alter table email_templates add column if not exists rep_id              integer;
alter table email_templates add column if not exists active              boolean not null default true;
alter table email_templates add column if not exists subject_format      text;
alter table email_templates add column if not exists intro_prompt        text;
alter table email_templates add column if not exists greeting_format     text;
alter table email_templates add column if not exists rep_intro_format    text;
alter table email_templates add column if not exists school_pitch_format text;
alter table email_templates add column if not exists cta_signoff_format  text;
alter table email_templates add column if not exists notes               text;
alter table email_templates add column if not exists created_at          timestamptz not null default now();
alter table email_templates add column if not exists updated_at          timestamptz not null default now();

create index if not exists idx_email_templates_rep
  on email_templates (rep_id) where active = true;
create index if not exists idx_email_templates_active
  on email_templates (active) where active = true;


-- ═════════════════════════════════════════════════════════════════
-- 011 — seed the "global" email template
-- ═════════════════════════════════════════════════════════════════

insert into email_templates (
  name, rep_id, active, subject_format, intro_prompt,
  greeting_format, rep_intro_format, school_pitch_format,
  cta_signoff_format, notes
)
values (
  'global',
  null,
  true,
  'Invitation to Apply - {{title}}的潜在算力支持机会',
  $PROMPT$根据论文写一句个性化开头（1句话）。

标题: {{title}}
摘要: {{abstract}}

格式：最近在跟踪A方向的研究时，读到你的X paper，其中用Y方法（不要超过8个字）解决Z问题（9个字以内）的方案很有启发。如果能有更多算力支持，相信可以（提供更多insights，更大程度上验证方法的普适性等，这里可以看一下作者可能希望做到的事情，写一下如果有更多算力做到什么）。

只返回这一句话。$PROMPT$,
  '{{first_name_or_you}}你好，',
  '我是奇绩创坛的{{rep_name}}。针对具备高潜力的前沿科研项目，奇绩算力计划目前正开放新一轮的申请，希望能通过免费算力，将科研的固定成本转变为边际成本，助力前沿想法的快速验证。',
  '{{school_text}}（{{base_info}}）{{directions_text}}。奇绩算力的特点是审核严格（通过率约1.5%），但额度较多，且完全免费（不占股，不要求署名，详见 {{wechat_article_url}} ）。',
  '如果{{closing_name}}对算力支持感兴趣，欢迎<a href="{{apply_url}}">申请</a>或加我微信交流（{{rep_wechat}}）。',
  'Baseline global template — mirrors email-generator.ts hardcoded output.'
)
on conflict (name) do update set
  subject_format      = excluded.subject_format,
  intro_prompt        = excluded.intro_prompt,
  greeting_format     = excluded.greeting_format,
  rep_intro_format    = excluded.rep_intro_format,
  school_pitch_format = excluded.school_pitch_format,
  cta_signoff_format  = excluded.cta_signoff_format,
  notes               = excluded.notes,
  updated_at          = now();


-- ═════════════════════════════════════════════════════════════════
-- 012 — brief_lookups attribution columns
-- ═════════════════════════════════════════════════════════════════

do $$
begin
  if not exists (select 1 from information_schema.tables where table_name = 'brief_lookups') then
    raise notice '[012] SKIP — brief_lookups does not exist (run /api/setup first).';
    return;
  end if;

  alter table brief_lookups add column if not exists marked_by_rep_id integer;
  alter table brief_lookups add column if not exists marked_by_email  text;
end $$;

create index if not exists idx_brief_lookups_marked_by
  on brief_lookups (marked_by_rep_id) where marked_by_rep_id is not null;


-- ═════════════════════════════════════════════════════════════════
-- 013 — helper FKs (only if helper_* tables AND sales_reps exist)
-- ═════════════════════════════════════════════════════════════════

do $$ begin
  if exists (select 1 from information_schema.tables where table_name = 'helper_rep_state')
     and exists (select 1 from information_schema.tables where table_name = 'sales_reps')
     and not exists (
       select 1 from information_schema.table_constraints
       where constraint_name = 'fk_helper_rep_state_sales_reps'
         and table_name = 'helper_rep_state'
     )
  then
    alter table helper_rep_state
      add constraint fk_helper_rep_state_sales_reps
      foreign key (rep_id) references sales_reps(id) on delete cascade;
  end if;
end $$;

do $$ begin
  if exists (select 1 from information_schema.tables where table_name = 'helper_conversations')
     and exists (select 1 from information_schema.tables where table_name = 'sales_reps')
     and not exists (
       select 1 from information_schema.table_constraints
       where constraint_name = 'fk_helper_conversations_sales_reps'
         and table_name = 'helper_conversations'
     )
  then
    alter table helper_conversations
      add constraint fk_helper_conversations_sales_reps
      foreign key (rep_id) references sales_reps(id) on delete cascade;
  end if;
end $$;


-- ═════════════════════════════════════════════════════════════════
-- 014 — rep_id on emails + inbound_emails, with back-fill
-- ═════════════════════════════════════════════════════════════════

do $$
begin
  if not exists (select 1 from information_schema.tables where table_name = 'emails')
     or not exists (select 1 from information_schema.tables where table_name = 'sales_reps')
  then
    raise notice '[014] SKIP — emails or sales_reps does not exist.';
    return;
  end if;

  alter table emails add column if not exists rep_id integer;

  if exists (select 1 from information_schema.tables where table_name = 'inbound_emails') then
    alter table inbound_emails add column if not exists rep_id integer;
  end if;

  update emails e
  set    rep_id = r.id
  from   sales_reps r
  where  e.rep_id is null
    and  r.active is true
    and  r.sender_email is not null
    and  e.from is not null
    and  e.from ilike '%' || r.sender_email || '%';

  if exists (select 1 from information_schema.tables where table_name = 'inbound_emails') then
    update inbound_emails i
    set    rep_id = e.rep_id
    from   emails e
    where  i.rep_id is null
      and  i.thread_id is not null
      and  e.thread_id = i.thread_id
      and  e.rep_id is not null;
  end if;
end $$;

create index if not exists idx_emails_rep_id
  on emails (rep_id) where rep_id is not null;

do $$ begin
  if exists (select 1 from information_schema.tables where table_name = 'inbound_emails') then
    create index if not exists idx_inbound_emails_rep_id
      on inbound_emails (rep_id) where rep_id is not null;
  end if;
end $$;


-- ═════════════════════════════════════════════════════════════════
-- 015 — pipeline_leads bounce / complained tracking
-- ═════════════════════════════════════════════════════════════════

alter table pipeline_leads add column if not exists bounced_at    timestamptz;
alter table pipeline_leads add column if not exists complained_at timestamptz;

create index if not exists idx_pipeline_leads_bounced
  on pipeline_leads (bounced_at) where bounced_at is not null;
create index if not exists idx_pipeline_leads_complained
  on pipeline_leads (complained_at) where complained_at is not null;


-- ═════════════════════════════════════════════════════════════════
-- 016 — brief_lookups FK to pipeline_leads + wechat dedup
-- ═════════════════════════════════════════════════════════════════

do $$
begin
  if not exists (select 1 from information_schema.tables where table_name = 'brief_lookups') then
    raise notice '[016] SKIP — brief_lookups does not exist.';
    return;
  end if;

  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'fk_brief_lookups_pipeline_leads'
      and table_name = 'brief_lookups'
  ) then
    update brief_lookups
    set    lead_id = null
    where  lead_id is not null
      and  lead_id not in (select id from pipeline_leads);

    alter table brief_lookups
      add constraint fk_brief_lookups_pipeline_leads
      foreign key (lead_id) references pipeline_leads(id) on delete set null;
  end if;

  -- Dedup: keep the oldest added_wechat=true row per lead, drop rest.
  with ranked as (
    select id,
           row_number() over (
             partition by lead_id
             order by wechat_at asc nulls last, id asc
           ) as rn
    from   brief_lookups
    where  added_wechat = true and lead_id is not null
  )
  delete from brief_lookups
  where id in (select id from ranked where rn > 1);
end $$;

do $$ begin
  if exists (select 1 from information_schema.tables where table_name = 'brief_lookups') then
    create unique index if not exists ux_brief_lookups_wechat_per_lead
      on brief_lookups (lead_id)
      where added_wechat = true and lead_id is not null;
  end if;
end $$;


-- ═════════════════════════════════════════════════════════════════
-- 017 — judge verdict history
-- ═════════════════════════════════════════════════════════════════

alter table pipeline_leads
  add column if not exists judge_verdicts_history jsonb
    not null default '[]'::jsonb;


-- ═════════════════════════════════════════════════════════════════
-- 018 — industry_orgs column
-- ═════════════════════════════════════════════════════════════════

alter table pipeline_leads add column if not exists industry_orgs text[];

create index if not exists idx_pipeline_leads_industry_orgs
  on pipeline_leads using gin (industry_orgs) where industry_orgs is not null;


-- ═══════════════════════════════════════════════════════════════════
-- Done. Check the "Messages" panel in Supabase SQL Editor — any block
-- that SKIPPED will print a NOTICE line explaining which table was
-- missing. Paste those back and I'll give you the bootstrap SQL for
-- that table so a full re-run lights everything up.
-- ═══════════════════════════════════════════════════════════════════
