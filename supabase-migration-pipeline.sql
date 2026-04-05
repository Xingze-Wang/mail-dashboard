-- Run this in Supabase SQL Editor

create table if not exists pipeline_leads (
  id text primary key default gen_random_uuid()::text,

  -- Paper info
  arxiv_id text unique not null,
  title text not null,
  abstract text,
  authors text,
  pdf_url text,
  published_at timestamptz,

  -- Lead info
  author_name text,
  author_email text not null,
  first_name text,
  school_name text,
  school_tier int,

  -- AI analysis
  compute_level text,
  compute_confidence float,
  compute_reason text,
  matched_directions text,

  -- Email draft
  draft_subject text,
  draft_html text,

  -- Status & workflow
  status text not null default 'new',
  source text not null default 'arxiv',

  -- Timestamps
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index if not exists idx_pipeline_status on pipeline_leads(status);
create index if not exists idx_pipeline_email on pipeline_leads(author_email);
create index if not exists idx_pipeline_created on pipeline_leads(created_at);
