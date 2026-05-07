-- migrations/054-onboarding.sql
--
-- 1. SCHEMA CHANGE
-- Two tables for the Lark-driven onboarding flow:
--   * onboarding_config — single-row key/value blob the admin fills in
--     once (sales group chat_id, doc URLs, day-one notes). Reused for
--     every future onboarding.
--   * pending_onboarding — one row per in-flight onboarding request.
--     Tracks lark identity, self-claimed name/email/wechat/password_hash,
--     conversation step, and admin decision.
--
-- 2. WHO WRITES THIS?
-- src/lib/onboarding.ts (new in this PR):
--   - onboarding_config: written by handleAdminOnboardingConfig() when
--     admin DMs Leon answers to the setup questions.
--   - pending_onboarding: written by handleNewRepConversation() when
--     a candidate progresses through the name/email/pw/wechat steps,
--     and by processOnboardingCardAction() when admin clicks
--     approve/deny.
--
-- 3. WHO READS THIS?
-- src/lib/onboarding.ts:
--   - State-machine driver checks pending_onboarding by lark_open_id
--     to know what step to ask next.
--   - On approval, reads pending_onboarding to populate sales_reps
--     INSERT and to know who to DM the welcome walkthrough to.
--   - onboarding_config read at walkthrough time to fill in doc URLs
--     and the sales group chat_id.
-- src/lib/lark-agent.ts: checks pending_onboarding before falling
--   through to the client-agent path, so a candidate mid-onboarding
--   is not treated as a customer.
--
-- 4. BACKFILL FOR OLD ROWS
-- (d) Not applicable — both tables are new and start empty. Existing
-- sales_reps rows (Leo / Yujie / Ethan / etc.) were created via prior
-- migrations and are NOT in pending_onboarding; that's correct, they
-- bypass this flow.

-- onboarding_config is single-row by design but stored as key/value so
-- the admin can append fields later (e.g., a new doc link) without DDL.
CREATE TABLE IF NOT EXISTS onboarding_config (
  key             text PRIMARY KEY,
  value           text NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by_rep  int REFERENCES sales_reps(id)
);

CREATE TABLE IF NOT EXISTS pending_onboarding (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lark_open_id        text NOT NULL UNIQUE,
  lark_name           text,
  lark_email          text,
  -- Conversation state. The driver in onboarding.ts uses this to know
  -- what to ask next. Order: ask_name → ask_email → ask_password →
  -- ask_wechat → awaiting_admin → approved | denied.
  step                text NOT NULL DEFAULT 'ask_name',
  claimed_name        text,
  claimed_email       text,
  claimed_wechat      text,
  -- bcrypt hash of the password the rep chose. Plaintext never persists.
  password_hash       text,
  -- Set by processOnboardingCardAction. Final states are 'approved' or 'denied'.
  status              text NOT NULL DEFAULT 'in_progress',
  decided_by_rep      int REFERENCES sales_reps(id),
  decided_at          timestamptz,
  -- Card message id so we can update the card after a decision (so the
  -- buttons disappear and the admin sees "approved by you at HH:MM").
  admin_card_message_id text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pending_onboarding_status_idx
  ON pending_onboarding(status)
  WHERE status = 'in_progress';
