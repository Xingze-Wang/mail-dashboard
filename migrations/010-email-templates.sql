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
