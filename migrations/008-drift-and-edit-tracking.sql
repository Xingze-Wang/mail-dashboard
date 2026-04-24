-- ═══════════════════════════════════════════════════════════════════
-- Migration 008: Drift + edit-tracking columns + tables
--
-- Drift page (/drift) + Judge-vs-Human queries columns + tables that
-- were never defined in a migration. Canonical, idempotent, safe on
-- re-run — adds ALTER TABLE ADD COLUMN IF NOT EXISTS for each field
-- so re-running against a table that already exists with a reduced
-- column set upgrades it instead of silently staying stale.
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

create index if not exists idx_pipeline_leads_judge_edit
  on pipeline_leads (sent_at desc)
  where judge_avg is not null and draft_edit_distance is not null;
create index if not exists idx_pipeline_leads_rep_edit_sent
  on pipeline_leads (assigned_rep_id, sent_at desc)
  where draft_edit_distance is not null;

-- ── prompt_drift_patterns ──────────────────────────────────────────
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

-- ── lead_corrections ───────────────────────────────────────────────
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
-- Patch in anything the pre-existing lead_corrections table might be
-- missing. This is the concrete fix for "ERROR: 42703: column
-- created_at does not exist" observed on 2026-04-24 — older tables
-- had corrected_at but not created_at, and the index below crashed.
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
