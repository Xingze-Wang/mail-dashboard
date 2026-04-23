-- ═══════════════════════════════════════════════════════════════════
-- Migration 007: Helper per-rep state (greeting + nudge cadence)
-- Run in Supabase SQL Editor.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS helper_rep_state (
  rep_id             INTEGER PRIMARY KEY,
  last_opened_at     TIMESTAMPTZ,
  last_greeting_at   TIMESTAMPTZ,       -- when we last showed the daily opener
  last_nudge_lead_id TEXT,              -- lead the last nudge was about (de-dup)
  notes              JSONB NOT NULL DEFAULT '{}'::jsonb,  -- agent-written prefs
  updated_at         TIMESTAMPTZ DEFAULT now() NOT NULL
);
