-- ═══════════════════════════════════════════════════════════════════
-- Migration 002: Sales Reps & Assignment Config
-- Run in Supabase SQL Editor when ready to enable multi-rep features
-- ═══════════════════════════════════════════════════════════════════

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

-- Seed Leo as default rep
INSERT INTO sales_reps (id, name, sender_email, sender_name, wechat_id, active)
VALUES (1, 'Leo', 'leo@compute.miracleplus.com', 'Leo', 'Lorenserus1', true)
ON CONFLICT (id) DO NOTHING;

-- Seed default assignment config
INSERT INTO system_config (key, value)
VALUES ('lead_assignment', '{"strong_criteria":{"min_h_index":20,"max_school_tier":2,"require_overseas":true},"assignment":{"strong":{"rep_id":1},"normal":{"rep_ids":[1],"mode":"round_robin"}}}')
ON CONFLICT (key) DO NOTHING;
