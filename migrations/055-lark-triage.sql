-- migrations/055-lark-triage.sql
--
-- 1. SCHEMA CHANGE
-- One new table: lark_triage_decisions. Keys on lark_open_id and stores
-- the user's answer to Leon's triage question ("are you 算力组 sales?").
-- Plus two new columns on pending_onboarding:
--   * claimed_role text — what role the user said they were ('sales' /
--     'senior' / 'admin'), used to preselect the admin card button.
--   * lark_chat_id text — the chat where the convo started, for sanity
--     auditing (we always REPLY to lark_open_id, never to chat_id).
--
-- 2. WHO WRITES THIS?
-- src/lib/onboarding.ts:
--   * lark_triage_decisions: written when a brand-new Lark user answers
--     the triage question (handleTriageStep).
--   * pending_onboarding.claimed_role: same place.
--   * pending_onboarding.lark_chat_id: written when startCandidateFlow
--     is called.
--
-- 3. WHO READS THIS?
-- onboarding.ts:
--   * triage decisions: tryHandleOnboardingMessage checks before
--     starting candidate flow. If decision='not_qiji' or
--     'qiji_other_team', skip onboarding and let client-agent path run.
--   * claimed_role: rendered on the admin approval card so admin can
--     verify "user said they're senior, am I OK with that?"
--   * lark_chat_id: not read by code; available for human audit.
--
-- 4. BACKFILL FOR OLD ROWS
-- (d) Not applicable. lark_triage_decisions starts empty. Existing
-- pending_onboarding rows (if any) get NULL for claimed_role and
-- lark_chat_id, which is fine — claimed_role just defaults the admin
-- card to the "sales" preselection (current behavior).

CREATE TABLE IF NOT EXISTS lark_triage_decisions (
  lark_open_id  text PRIMARY KEY,
  decision      text NOT NULL,
    -- 'is_sales'         — claimed to be 算力组 sales; onboarding flow proceeds
    -- 'qiji_other_team'  — claimed Qiji but not 算力组; admin notified, no auto-onboard
    -- 'not_qiji'         — not Qiji at all; client-agent handles them as customer
  claimed_role  text,                  -- if is_sales: 'sales' | 'senior' | 'admin'
  decided_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pending_onboarding
  ADD COLUMN IF NOT EXISTS claimed_role text,
  ADD COLUMN IF NOT EXISTS lark_chat_id text;
