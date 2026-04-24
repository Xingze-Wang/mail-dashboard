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
