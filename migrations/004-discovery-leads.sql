-- ═══════════════════════════════════════════════════════════════════
-- Migration 004: Discovery leads (multi-source scout pipeline)
--
-- Purpose
--   The Python scrapers (HuggingFace / Product Hunt / GitHub) write
--   raw "discovery" rows into `discovery_leads`. Once a row earns a
--   real email + a promotion decision, it gets copied into the
--   existing `pipeline_leads` table and `promoted_at` is stamped.
--
--   `scan_state` is a single-row-per-scan-type cursor table so the
--   Python jobs can resume incrementally (timestamp or opaque token).
--
-- Run in Supabase SQL Editor (or POST /api/migrate/004-discovery).
-- Idempotent — safe to re-run.
-- ═══════════════════════════════════════════════════════════════════

create table if not exists discovery_leads (
  id           bigserial primary key,
  source       text not null,           -- 'hf' | 'ph' | 'github'
  external_id  text not null,           -- hf username / ph username / gh login
  score        real not null default 0,
  signals      jsonb not null default '{}',
  profile_url  text,
  fullname     text,
  location     text,
  org          text,
  bio          text,
  contact_hint text,
  email        text,                    -- nullable; filled when discovered
  promoted_at  timestamptz,             -- when moved into pipeline_leads
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now(),
  hit_count    int not null default 1,
  unique (source, external_id)
);

create index if not exists idx_discovery_source_score on discovery_leads (source, score desc);
create index if not exists idx_discovery_last_seen on discovery_leads (last_seen desc);
create index if not exists idx_discovery_email_null on discovery_leads (source) where email is null;

create table if not exists scan_state (
  scan_type        text primary key,    -- 'hf_models' | 'ph_posts' | 'gh_trending' | 'arxiv'
  cursor_timestamp timestamptz,
  cursor_token     text,
  last_run_at      timestamptz
);
