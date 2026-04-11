-- ═══════════════════════════════════════════════════════════════════
-- Migration 001: Lead Assignment + Persons
-- Run in Supabase SQL Editor (supabase.com → project → SQL Editor)
-- ═══════════════════════════════════════════════════════════════════

-- ─── Part A: Lead Assignment tables ──────────────────────────────

CREATE TABLE IF NOT EXISTS sales_reps (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  sender_email TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  wechat_id TEXT NOT NULL,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS system_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- New columns on pipeline_leads
ALTER TABLE pipeline_leads ADD COLUMN IF NOT EXISTS s2_author_id TEXT;
ALTER TABLE pipeline_leads ADD COLUMN IF NOT EXISTS h_index INTEGER;
ALTER TABLE pipeline_leads ADD COLUMN IF NOT EXISTS citation_count INTEGER;
ALTER TABLE pipeline_leads ADD COLUMN IF NOT EXISTS paper_count INTEGER;
ALTER TABLE pipeline_leads ADD COLUMN IF NOT EXISTS lead_tier TEXT DEFAULT 'normal';
ALTER TABLE pipeline_leads ADD COLUMN IF NOT EXISTS assigned_rep_id INTEGER;

-- Seed Leo
INSERT INTO sales_reps (id, name, sender_email, sender_name, wechat_id, active)
VALUES (1, 'Leo', 'leo@compute.miracleplus.com', 'Leo', 'Lorenserus1', true)
ON CONFLICT (id) DO NOTHING;

-- Seed default assignment config
INSERT INTO system_config (key, value)
VALUES ('lead_assignment', '{"strong_criteria":{"min_h_index":20,"max_school_tier":2,"require_overseas":true},"assignment":{"strong":{"rep_id":1},"normal":{"rep_ids":[1],"mode":"round_robin"}}}')
ON CONFLICT (key) DO NOTHING;


-- ─── Part B: Persons table ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS persons (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,

  -- 身份证据 (数组存多身份)
  emails TEXT[] NOT NULL DEFAULT '{}',
  hf_users TEXT[] NOT NULL DEFAULT '{}',
  github_users TEXT[] NOT NULL DEFAULT '{}',
  arxiv_author_names TEXT[] NOT NULL DEFAULT '{}',

  -- 画像
  real_name TEXT,
  first_name TEXT,
  affiliation TEXT,
  school_name TEXT,
  school_tier INT,
  bio TEXT,

  -- Outreach 状态
  last_outreach_at TIMESTAMPTZ,
  last_outreach_source TEXT,
  outreach_count INT NOT NULL DEFAULT 0,
  outreach_status TEXT NOT NULL DEFAULT 'new',
  replied_at TIMESTAMPTZ,

  -- 发现来源汇总
  source_events JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- 时间戳
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- GIN 索引 (归并核心)
CREATE INDEX IF NOT EXISTS idx_persons_emails ON persons USING gin (emails);
CREATE INDEX IF NOT EXISTS idx_persons_hf ON persons USING gin (hf_users);
CREATE INDEX IF NOT EXISTS idx_persons_github ON persons USING gin (github_users);
CREATE INDEX IF NOT EXISTS idx_persons_arxiv_names ON persons USING gin (arxiv_author_names);
CREATE INDEX IF NOT EXISTS idx_persons_outreach_at ON persons(last_outreach_at);
CREATE INDEX IF NOT EXISTS idx_persons_status ON persons(outreach_status);

-- 外键 (渐进迁移,不 NOT NULL)
ALTER TABLE pipeline_leads ADD COLUMN IF NOT EXISTS person_id TEXT REFERENCES persons(id);
ALTER TABLE paper_authors ADD COLUMN IF NOT EXISTS person_id TEXT REFERENCES persons(id);
ALTER TABLE email_contact_history ADD COLUMN IF NOT EXISTS person_id TEXT REFERENCES persons(id);

CREATE INDEX IF NOT EXISTS idx_pipeline_leads_person ON pipeline_leads(person_id);
CREATE INDEX IF NOT EXISTS idx_paper_authors_person ON paper_authors(person_id);
CREATE INDEX IF NOT EXISTS idx_email_contact_person ON email_contact_history(person_id);
