-- Migration 037: Lark bot identity mapping
--
-- Adds the columns we need to map a Lark message author back to one of
-- our sales_reps rows. open_id is per-app (stable across messages from
-- the same user in the same Lark app); union_id is per-tenant; email is
-- the user's Lark-side email which is convenient when admins want to
-- pre-bind a colleague before that person has ever messaged.
--
-- We index open_id because the webhook does a hot lookup on it.

ALTER TABLE sales_reps ADD COLUMN IF NOT EXISTS lark_open_id TEXT;
ALTER TABLE sales_reps ADD COLUMN IF NOT EXISTS lark_union_id TEXT;
ALTER TABLE sales_reps ADD COLUMN IF NOT EXISTS lark_email TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_reps_lark_open_id ON sales_reps (lark_open_id) WHERE lark_open_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sales_reps_lark_email ON sales_reps (lark_email) WHERE lark_email IS NOT NULL;

-- Lark conversation log — each Lark message + its reply, for audit and
-- so the helper can read prior turns when the user replies in the same
-- thread. We do NOT reuse helper_conversations because that table is
-- keyed by rep_id and assumes web-app session — Lark needs the chat_id
-- (the Lark thread id) so consecutive messages link together.

CREATE TABLE IF NOT EXISTS lark_messages (
  id SERIAL PRIMARY KEY,
  chat_id TEXT NOT NULL,
  message_id TEXT,                     -- Lark's own message_id (om_...)
  rep_id INTEGER REFERENCES sales_reps(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  text TEXT NOT NULL,
  raw JSONB,                           -- the full Lark event body for replay/debug
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lark_messages_chat_id ON lark_messages (chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lark_messages_rep_id ON lark_messages (rep_id, created_at DESC);
