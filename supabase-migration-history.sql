-- Run this in Supabase SQL Editor BEFORE running the migration script
-- Then run: node scripts/migrate-history.mjs

-- Stores every email address we've ever contacted + when
-- Used for dedup: don't contact same person within 365 days
create table if not exists email_contact_history (
  email text primary key,
  paper_title text,
  subject text,
  contacted_at timestamptz not null,
  source text default 'python_script'
);

-- Stores every arxiv paper ID we've already processed (analyzed)
-- Used to avoid re-analyzing the same paper
create table if not exists processed_papers (
  arxiv_id text primary key,
  processed_at timestamptz not null default now()
);

-- Scanner state: checkpoint + last run time
create table if not exists scanner_state (
  id text primary key default 'default',
  last_arxiv_id text,
  last_run timestamptz,
  updated_at timestamptz not null default now()
);
