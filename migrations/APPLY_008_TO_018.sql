-- ═══════════════════════════════════════════════════════════════════
-- APPLY migrations 008 → 018 in one shot.
--
-- Paste the entire file into Supabase SQL Editor and run. Each block
-- is individually idempotent (IF NOT EXISTS on columns/tables/indexes,
-- DO blocks around FKs, ON CONFLICT on seeds). Safe to re-run, safe
-- to run partially — any already-applied migration no-ops.
--
-- Order matters: 008 creates drift tables + columns that 011's seed
-- and 016's dedup rely on. Run top-to-bottom.
--
-- After this file completes:
--   - /drift and /drift Judge-vs-Human work
--   - Helper chime-in + voice templates wire up end-to-end
--   - rep_id is stamped on emails/inbound_emails and back-filled
--   - brief_lookups has FK + dedup
--   - judge_verdicts_history preserves drift-over-time signal
--   - industry_orgs column backs the classifyLead +2500 bonus
--
-- Earlier migrations (001 → 007) are NOT included here — those are
-- already live in prod. If you're bootstrapping a fresh DB, run 001–
-- 007 first (or use the full migrations/ folder in order).
-- ═══════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════
-- Migration 008: Drift + edit-tracking columns + tables
--
-- What was missing:
--   The drift page (/drift) and Judge vs Human tab query columns and
--   tables that were never defined in a migration — they had been
--   added ad-hoc in Supabase at some point or never at all. This
--   migration is the canonical, idempotent definition.
--
-- Adds:
--   pipeline_leads columns for edit-tracking + judge ensemble:
--     draft_original_subject, draft_original_html, draft_model,
--     draft_edit_distance, edit_reasons, edit_note,
--     judge_avg, judge_prompt_leak, judge_at, judge_verdicts
--
--   prompt_drift_patterns  — mined drift signals
--   lead_corrections       — sales "flag" signal (right lead wrong
--                            pitch / wrong author / etc.)
--
-- Idempotent — safe to re-run. All columns use IF NOT EXISTS.
-- ═══════════════════════════════════════════════════════════════════

-- pipeline_leads: edit-tracking + judge columns
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

-- Index to make Judge-vs-Human query cheap (scans ~500 newest sent
-- rows with both signals).
create index if not exists idx_pipeline_leads_judge_edit
  on pipeline_leads (sent_at desc)
  where judge_avg is not null and draft_edit_distance is not null;

-- Index for the heavy-editor chime-in rule (count edits per rep in 7d
-- window where draft_edit_distance is meaningful).
create index if not exists idx_pipeline_leads_rep_edit_sent
  on pipeline_leads (assigned_rep_id, sent_at desc)
  where draft_edit_distance is not null;

-- ── prompt_drift_patterns ──────────────────────────────────────────
create table if not exists prompt_drift_patterns (
  id                uuid primary key default gen_random_uuid(),
  detected_at       timestamptz not null default now(),
  rep_id            integer,                     -- null = global pattern
  category          text not null,               -- ai_misunderstood | format | too_verbose | too_robotic | individual_taste
  ai_phrase         text not null,
  sales_phrase      text,                        -- null when sales deleted it
  occurrence_count  integer not null default 1,
  example_lead_ids  text[] not null default '{}',
  prompt_patch      text,
  status            text not null default 'pending'  -- pending | accepted | ignored
                    check (status in ('pending','accepted','ignored')),
  accepted_at       timestamptz,
  accepted_by       text
);

create index if not exists idx_drift_patterns_status_detected
  on prompt_drift_patterns (status, detected_at desc);
create index if not exists idx_drift_patterns_rep
  on prompt_drift_patterns (rep_id);
create index if not exists idx_drift_patterns_category
  on prompt_drift_patterns (category);

-- ── lead_corrections ───────────────────────────────────────────────
-- Sales-facing "flag" for leads. Every row is one flag event; a single
-- lead can have many (different reps over time, different reasons).
-- `corrected_by` is the rep's email (legacy); `rep_id` is the FK added
-- later so newer writes can record which rep. Both columns exist for
-- compatibility with older insert paths.
create table if not exists lead_corrections (
  id            uuid primary key default gen_random_uuid(),
  lead_id       uuid not null,
  rep_id        integer,
  type          text not null,            -- bad_compute | wrong_author | wrong_direction | low_quality_email | right_lead_wrong_pitch | good_lead
  severity      text default 'soft'       -- soft | hard
                check (severity in ('soft','hard')),
  reason        text,
  payload       jsonb,
  skip          boolean default false,    -- did sales also skip the lead?
  corrected_by  text,                     -- legacy: rep email
  corrected_at  timestamptz default now(),
  created_at    timestamptz default now()
);

create index if not exists idx_lead_corrections_lead
  on lead_corrections (lead_id);
create index if not exists idx_lead_corrections_created
  on lead_corrections (created_at desc);
create index if not exists idx_lead_corrections_rep
  on lead_corrections (rep_id);
create index if not exists idx_lead_corrections_type
  on lead_corrections (type);
-- ═══════════════════════════════════════════════════════════════════
-- Migration 009: Proactive chime-in for the sales helper
--
-- Adds `pending_chime_in` to `helper_rep_state`. A daily cron
-- (/api/cron/proactive-signals) scans per-rep activity and, when a
-- hard-coded signal rule trips, writes a JSON blob here describing
-- what the helper should mention the next time the rep opens the
-- chat (pull-style — never auto-pops the chat).
--
-- Consumed by /api/help/opening, which prepends the chime-in above
-- the daily opener message. Client clears it via the consume endpoint
-- once shown.
--
-- Shape (v1, just "heavy editor" rule):
--   {
--     "type": "voice_capture_offer",
--     "edit_count": 5,
--     "window_days": 7,
--     "detected_at": "2026-04-23T01:30:00Z"
--   }
--
-- Other types will share this slot (only one pending at a time — the
-- newer signal overwrites the older; rep hasn't acted on the old one
-- anyway). If we ever need a queue, this becomes an array column.
-- ═══════════════════════════════════════════════════════════════════

alter table helper_rep_state
  add column if not exists pending_chime_in jsonb;
-- ═══════════════════════════════════════════════════════════════════
-- Migration 010: Structured email templates (for per-rep voice)
--
-- The existing `templates` table holds a single `html` blob and is
-- used for both (a) free-form email bodies and (b) a single singleton
-- "pipeline_intro_prompt" row whose `html` column actually stores an
-- LLM prompt. That worked when drafts were hardcoded in
-- email-generator.ts with one blank (paragraph 2 = LLM intro) — but
-- per-rep voice needs the whole email to be template-driven.
--
-- This new table stores *structured* email templates. Each row is a
-- full email skeleton: subject line, greeting style, LLM intro prompt,
-- rep intro paragraph, school/compute pitch paragraph, CTA + signoff.
-- The `template-assembler.ts` lib takes a row + a lead + a rep and
-- produces the final {subject, html}.
--
-- Scope:
--   - `name` is the stable key (e.g. "global" or "rep_chenyu").
--   - `rep_id` is null for the global template, set for per-rep.
--   - Exactly one "global" row should exist; its content should match
--     email-generator.ts's current hardcoded output byte-for-byte for
--     the v1 rollout (no behavior change from the refactor alone).
--   - Per-rep rows override the global when a lead's assigned_rep_id
--     matches.
--
-- Idempotent. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════

create table if not exists email_templates (
  id               uuid primary key default gen_random_uuid(),
  name             text not null unique,            -- 'global' | 'rep_chenyu' | 'rep_ethan' ...
  rep_id           integer,                          -- null = global
  active           boolean not null default true,

  -- Subject format with {{title}} placeholder. Truncation handled by
  -- the assembler, not here.
  subject_format   text not null,

  -- LLM prompt used to produce the personalized intro (paragraph 2).
  -- Same shape as today's pipeline_intro_prompt — {{title}},
  -- {{abstract}} placeholders, returns one sentence.
  intro_prompt     text not null,

  -- Hardcoded parts, with {{rep_name}}, {{closing_name}}, {{rep_wechat}}
  -- placeholders. School/compute pitch is computed in code (depends on
  -- SCHOOL_DATA + matched_directions) so it takes a different template:
  -- school_pitch_format gets {{school_text}}, {{base_info}},
  -- {{directions_text}} substituted before inclusion.
  greeting_format      text not null,   -- "{{first_name}}你好，" | "你好，"
  rep_intro_format     text not null,   -- "我是奇绩创坛的{{rep_name}}。针对..."
  school_pitch_format  text not null,   -- "{{school_text}}（{{base_info}}）..."
  cta_signoff_format   text not null,   -- "如果{{closing_name}}对算力支持感兴趣..."

  notes            text,                             -- human note: where this template came from
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists idx_email_templates_rep on email_templates (rep_id) where active = true;
create index if not exists idx_email_templates_active on email_templates (active) where active = true;
-- ═══════════════════════════════════════════════════════════════════
-- Migration 011: Seed the "global" email template
--
-- Mirrors email-generator.ts's current hardcoded output exactly, so
-- the template-driven assembler produces byte-identical drafts to the
-- pre-refactor code when no per-rep template exists.
--
-- Keep in sync with src/lib/email-generator.ts:
--   - subject_format: line 272
--   - greeting_format: lines 239-240
--   - rep_intro_format: line 280
--   - school_pitch_format: lines 104-108 (generateThirdParagraph)
--   - cta_signoff_format: lines 282-283
--
-- Re-runs are safe: uses ON CONFLICT (name) DO UPDATE so edits to this
-- seed file will overwrite the row on re-migration. Manual edits in
-- Supabase will therefore be lost on next deploy — if you want to
-- customize the global template, use the Templates UI and make a new
-- non-"global" row OR turn this migration into a one-shot insert with
-- ON CONFLICT DO NOTHING (decide based on how you want ownership to
-- work). For now, "this migration is the source of truth" is simpler.
-- ═══════════════════════════════════════════════════════════════════

insert into email_templates (name, rep_id, active, subject_format, intro_prompt, greeting_format, rep_intro_format, school_pitch_format, cta_signoff_format, notes)
values (
  'global',
  null,
  true,
  'Invitation to Apply - {{title}}的潜在算力支持机会',
  $PROMPT$根据论文写一句个性化开头（1句话）。

标题: {{title}}
摘要: {{abstract}}

格式：最近在跟踪A方向的研究时，读到你的X paper，其中用Y方法（不要超过8个字）解决Z问题（9个字以内）的方案很有启发。如果能有更多算力支持，相信可以（提供更多insights，更大程度上验证方法的普适性等，这里可以看一下作者可能希望做到的事情，写一下如果有更多算力做到什么）。

**任何情况下，严禁出现""，*，//，%，$等任何符号**

注意：
1. A方向
- 这里需要找一个相对大一些的领域（e.g. Dyna网状Web agent架构 -> Web Agent方向研究）
- 第二个例子：Principle-Evolvable Scientific Discovery via Uncertainty Minimization -> AI4S相关
- 此外，要学会使用更加常用的表达（e.g. Offline Reinforcement Learning就说Offline RL，不要说离线强化学习）

错误例子：
- 最近在跟踪RAG查询优化研究 - 不像人话
- 推荐系统解释性 - 应该是推荐系统可解释性，人类不会说"解释性"这种词，而是"可解释性"

正确例子：
- 最近在整理可解释性领域的最新进展
- 最近在跟踪Agentic RL相关的研究
- 最近在跟踪持续学习方向的工作

2. X paper
- 如果论文标题是 xx: xxxx，那么用：前面的部分即可 （e.g. RobustExplain: Evaluating Robustness of LLM-Based Explanation Agents for Recommendation -> RobustExplain paper)
- 如果论文标题没有冒号，直接用《完整标题》，e.g. 读到你的《Interpreting Emergent Extreme Events in Multi-Agent Systems》，其中用...
- 如果论文标题过长（超过10个英文单词），可以简化为"你的关于YYY的论文"，YYY是论文的核心内容，不直接用标题。

3. Y方法解决Z问题 - 不要超过12个字
- option a: 基于Y方法，解决Z问题
- option b: 解释了xx现象 / 深入分析了xx问题 / 揭示了xx机制

**注意：一定是三段论，每一个部分中间有逗号（最近在...，读到了...，其中）**

正确例子：
- 最近在跟踪持续学习方向的工作，读到了你的关于平衡模型稳定性和可塑性的论文，揭示了经验回放(ER)在不同任务上的二元性，很有启发。文中指出了经验回放会导致代码生成等结构化任务的负迁移，如果能在更大规模的模型上验证，相信能提供更多关于持续学习的 insights。
- 最近在跟踪可解释性相关研究时，读到你的《Interpreting Emergent Extreme Events in Multi-Agent Systems》，其中用基于Shapley值进行多维度归因的方法解决解释multi-agent system涌现极端事件的方案很有启发。
- 最近在跟踪Web Agent相关研究时，读到你的DynaWeb paper，其中通过学习一个网络世界模型作为合成环境的方案很有启发。

只返回这一句话。$PROMPT$,
  '{{first_name_or_you}}你好，',
  '我是奇绩创坛的{{rep_name}}。针对具备高潜力的前沿科研项目，奇绩算力计划目前正开放新一轮的申请，希望能通过免费算力，将科研的固定成本转变为边际成本，助力前沿想法的快速验证。',
  '{{school_text}}（{{base_info}}）{{directions_text}}。奇绩算力的特点是审核严格（通过率约1.5%），但额度较多，且完全免费（不占股，不要求署名，详见 {{wechat_article_url}} ）。',
  '如果{{closing_name}}对算力支持感兴趣，欢迎<a href="{{apply_url}}">申请</a>或加我微信交流（{{rep_wechat}}）。',
  'Baseline global template — mirrors email-generator.ts hardcoded output as of migration 011.'
)
on conflict (name) do update set
  subject_format     = excluded.subject_format,
  intro_prompt       = excluded.intro_prompt,
  greeting_format    = excluded.greeting_format,
  rep_intro_format   = excluded.rep_intro_format,
  school_pitch_format= excluded.school_pitch_format,
  cta_signoff_format = excluded.cta_signoff_format,
  notes              = excluded.notes,
  updated_at         = now();
-- ═══════════════════════════════════════════════════════════════════
-- Migration 012: Brief lookups attribution
--
-- Adds rep attribution to `brief_lookups` so admin can audit WeChat
-- conversion marks. Before this, /api/brief/wechat POSTed to the
-- table with no record of which rep clicked "Added on WeChat" —
-- which made per-rep conversion stats impossible to compute.
--
-- Brief search itself stays cross-rep by product design (when
-- someone adds a rep on WeChat, any rep may need to look them up),
-- but the conversion-mark event now tracks who did it.
--
-- Idempotent.
-- ═══════════════════════════════════════════════════════════════════

alter table brief_lookups
  add column if not exists marked_by_rep_id integer;
alter table brief_lookups
  add column if not exists marked_by_email  text;

create index if not exists idx_brief_lookups_marked_by
  on brief_lookups (marked_by_rep_id) where marked_by_rep_id is not null;
-- ═══════════════════════════════════════════════════════════════════
-- Migration 013: Foreign keys for helper tables
--
-- Migrations 006 (helper_conversations/helper_messages) and 007
-- (helper_rep_state) declared rep_id as a plain INTEGER with no FK
-- to sales_reps. Deleting a rep row leaves orphans in both tables —
-- helper_rep_state becomes unreachable (PK is rep_id, but sales_reps
-- row gone) and helper_conversations become invisible to non-admin
-- (filter is rep_id == session.repId).
--
-- Adds FKs with ON DELETE CASCADE so rep deletion cleans up cleanly.
-- Using DO blocks + IF NOT EXISTS-style checks to stay idempotent
-- across re-runs; Postgres doesn't support "ADD CONSTRAINT IF NOT
-- EXISTS" directly before 17.
-- ═══════════════════════════════════════════════════════════════════

do $$ begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'fk_helper_rep_state_sales_reps'
      and table_name = 'helper_rep_state'
  ) then
    alter table helper_rep_state
      add constraint fk_helper_rep_state_sales_reps
      foreign key (rep_id) references sales_reps(id) on delete cascade;
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'fk_helper_conversations_sales_reps'
      and table_name = 'helper_conversations'
  ) then
    alter table helper_conversations
      add constraint fk_helper_conversations_sales_reps
      foreign key (rep_id) references sales_reps(id) on delete cascade;
  end if;
end $$;
-- ═══════════════════════════════════════════════════════════════════
-- Migration 014: rep_id columns on emails + inbound_emails
--
-- Today, /api/inbox/unread-count, /api/inbound, /api/emails, and
-- /api/metrics scope non-admin users by `emails.from ilike sender_email`
-- — a proxy filter. If a rep's sender_email ever changes in sales_reps,
-- their entire historical email scope breaks silently (unread goes to
-- zero, inbox empties, metrics stop counting them). The canonical field
-- to scope by is sales_reps.id.
--
-- This migration ADDS the columns and back-fills them from current
-- sender_email matches. It does NOT flip the routes yet — a follow-up
-- code change will swap the filters once we trust the column is
-- populated in prod. Keeping the sender_email fallback meanwhile means
-- old rows that don't match any active rep (historical sender_emails,
-- seed data) stay visible.
--
-- Idempotent.
-- ═══════════════════════════════════════════════════════════════════

alter table emails
  add column if not exists rep_id integer;
alter table inbound_emails
  add column if not exists rep_id integer;

-- Back-fill: match each outbound email's `from` substring to an active
-- rep's sender_email. Using ilike so casing and "Name <addr>" wrappers
-- don't break the match. Only overwrites rep_id=null rows so re-runs
-- are safe and manual assignments (if any) are preserved.
update emails e
set    rep_id = r.id
from   sales_reps r
where  e.rep_id is null
  and  r.active is true
  and  r.sender_email is not null
  and  e.from is not null
  and  e.from ilike '%' || r.sender_email || '%';

-- For inbound_emails, rep attribution is by thread: we owned the thread
-- if an outbound email on that thread has a rep_id. Two-step join so
-- the UPDATE ... FROM stays readable.
update inbound_emails i
set    rep_id = e.rep_id
from   emails e
where  i.rep_id is null
  and  i.thread_id is not null
  and  e.thread_id = i.thread_id
  and  e.rep_id is not null;

create index if not exists idx_emails_rep_id
  on emails (rep_id) where rep_id is not null;
create index if not exists idx_inbound_emails_rep_id
  on inbound_emails (rep_id) where rep_id is not null;
-- ═══════════════════════════════════════════════════════════════════
-- Migration 015: Pipeline_leads bounce + complaint tracking
--
-- Resend webhooks (email.bounced, email.complained) previously only
-- updated the emails table. pipeline_leads.status stayed at 'sent'
-- regardless, so reps couldn't see which sends never landed. We don't
-- want to regress the status string (it's used for ready/sent/replied
-- transitions and overwriting it would lose reply signal), so we add
-- two dedicated timestamp columns that the webhook populates.
--
-- Metrics can now surface "X bounced this week" and the drift miner
-- can filter them out of "good sends" samples.
--
-- Idempotent.
-- ═══════════════════════════════════════════════════════════════════

alter table pipeline_leads add column if not exists bounced_at    timestamptz;
alter table pipeline_leads add column if not exists complained_at timestamptz;

create index if not exists idx_pipeline_leads_bounced
  on pipeline_leads (bounced_at) where bounced_at is not null;
create index if not exists idx_pipeline_leads_complained
  on pipeline_leads (complained_at) where complained_at is not null;
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
-- ═══════════════════════════════════════════════════════════════════
-- Migration 017: Preserve judge verdict history across re-judges
--
-- /api/drift/rejudge was overwriting judge_verdicts + judge_avg each
-- run, destroying the baseline it was meant to compare against. The
-- whole point of re-judging is to detect rubric drift over time.
--
-- Adds judge_verdicts_history (JSONB array of past verdicts + avg +
-- timestamp). The rejudge route now prepends the current verdicts to
-- this array before overwriting current, capped at 20 entries so
-- JSONB doesn't grow unbounded.
--
-- Idempotent.
-- ═══════════════════════════════════════════════════════════════════

alter table pipeline_leads
  add column if not exists judge_verdicts_history jsonb
    not null default '[]'::jsonb;
-- ═══════════════════════════════════════════════════════════════════
-- Migration 018: industry_orgs column on pipeline_leads
--
-- /api/pipeline/import populates an `industry_orgs` array (e.g.
-- ["OpenAI", "Anthropic"]) detected from S2 affiliations + ack mining,
-- and classifyLead() in lib/assignment.ts gives a +2500 citation-
-- equivalent bonus when it's non-empty. But no migration created the
-- column, so the write silently fails (supabase returns PGRST204) and
-- industry-affiliated researchers keep getting classified as 'normal'.
--
-- The /api/config/assignment POST re-classify now reads the column
-- so a re-run after seeding the column can correct historical rows.
--
-- Idempotent.
-- ═══════════════════════════════════════════════════════════════════

alter table pipeline_leads
  add column if not exists industry_orgs text[];

create index if not exists idx_pipeline_leads_industry_orgs
  on pipeline_leads using gin (industry_orgs) where industry_orgs is not null;
