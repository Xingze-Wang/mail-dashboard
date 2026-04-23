-- ═══════════════════════════════════════════════════════════════════
-- Migration 006: Persist Sales Helper conversations + tool-use audit
-- Run in Supabase SQL Editor.
-- ═══════════════════════════════════════════════════════════════════
--
-- Two tables:
--  helper_conversations — one row per conversation thread (rep + started_at)
--  helper_messages      — N rows per conversation, ordered by created_at,
--                         carrying the role + text + optional tool-use payload

CREATE TABLE IF NOT EXISTS helper_conversations (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  rep_id       INTEGER NOT NULL,
  mode         TEXT NOT NULL DEFAULT 'sales',  -- 'sales' | 'paper'
  title        TEXT,                            -- first user message, truncated
  lead_id      TEXT,                            -- present for paper-mode threads
  created_at   TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at   TIMESTAMPTZ DEFAULT now() NOT NULL,
  archived     BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_helper_conversations_rep
  ON helper_conversations (rep_id, archived, updated_at DESC);

CREATE TABLE IF NOT EXISTS helper_messages (
  id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  conversation_id  TEXT NOT NULL REFERENCES helper_conversations(id) ON DELETE CASCADE,
  role             TEXT NOT NULL,      -- 'user' | 'assistant' | 'tool'
  text             TEXT,
  -- Tool-use: when the assistant proposes a destructive action, it
  -- emits a JSON payload describing the action. The client renders
  -- a confirm card; execution only happens after user clicks Confirm,
  -- which hits a separate endpoint (/api/help/execute). That call
  -- writes a 'tool' message recording what actually ran.
  tool_proposal    JSONB,
  tool_result      JSONB,
  created_at       TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_helper_messages_conv
  ON helper_messages (conversation_id, created_at);
