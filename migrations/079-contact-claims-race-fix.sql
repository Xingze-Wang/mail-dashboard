-- 079-contact-claims-race-fix.sql
-- ════════════════════════════════════════════════════════════════════
-- 1. SCHEMA CHANGE
--
-- contact_claims: a TTL'd lock table that hard-closes the double-send
-- race. Today's contact-guard (src/lib/contact-guard.ts) checks
-- emails.to + email_contact_history + persons.last_outreach_at for any
-- contact in the last 365 days. The check is correct in isolation but
-- has a TOCTOU window: from `await checkSendAllowed` (line 172 in
-- send/route.ts) through `await resend.emails.send` (~2s) through the
-- final `emails.insert`, two parallel sends to the SAME recipient via
-- DIFFERENT lead rows can both pass the check.
--
-- Audit (scripts/_audit-dedup.mjs) found 12 such doubles in the last
-- year. Worst case williamxwang03@gmail.com got 3 sends on the same
-- day within 50 minutes. This migration closes that hole.
--
-- HOW THE CLAIM WORKS:
--   1. send/batch-send INSERTs into contact_claims with email=<lower(to)>
--   2. Unique index on (email_normalized) means the SECOND parallel
--      send fails with Postgres 23505 → guard returns "already_claimed"
--   3. After Resend success → keep the row (becomes a 365d record)
--   4. After Resend failure → DELETE the claim so retries are possible
--   5. TTL'd cleanup: rows older than 365d can be GC'd; or we just
--      keep them — they're already covered by emails.to dedup anyway.
--
-- 2. WHO WRITES
--   - POST /api/pipeline/send  — claim before Resend, release on fail
--   - POST /api/pipeline/batch-send — same per-lead
--
-- 3. WHO READS
--   - The unique-index conflict IS the read (Postgres handles atomically)
--   - lastContactedAt() in contact-guard could optionally add this as a
--     4th source, but emails.to already covers the 365d window
--
-- 4. BACKFILL
--   Empty at start. The race-protection is forward-looking — existing
--   emails are already covered by the 365d emails.to lookup.
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS contact_claims (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stored already-lowercased + trimmed. The application is responsible
  -- for normalizing; we don't trust input. Length 255 covers RFC 5321.
  email_normalized text NOT NULL,
  -- Who claimed (for debug — same actor convention as emails.actor_rep_id).
  actor_rep_id    int REFERENCES sales_reps(id),
  -- Which lead the claim is for, so we can correlate to pipeline_leads
  -- when debugging. Nullable because tests can claim without a lead.
  lead_id         text REFERENCES pipeline_leads(id) ON DELETE SET NULL,
  -- Which paper, mirrors emails.paper_arxiv_id pattern.
  paper_arxiv_id  text,
  -- When the claim was made. Becomes the dedup timestamp once Resend
  -- succeeds; left in place for the 365-day rolling window.
  claimed_at      timestamptz NOT NULL DEFAULT now(),
  -- Once Resend confirms, we flip this to true. Failed sends remain
  -- false → cron can GC them after a short cooldown (~5 min) so retry
  -- is possible. Successful claims (true) sit for 365d as dedup proof.
  confirmed       boolean NOT NULL DEFAULT false,
  -- The Resend message id, if known. Lets us reconcile against the
  -- emails table when an audit needs to.
  resend_id       text
);

-- THE atomic gate: one active claim per email at a time. Two parallel
-- INSERTs to the same email_normalized → one wins, one gets 23505.
-- This is the entire point of the migration. Without UNIQUE this table
-- is just a log, not a lock.
--
-- Excludes our own audit-CC address (williamxwang03@gmail.com), which
-- is deliberately copied on every send. Without the WHERE, the index
-- would block the second send's CC and break the system entirely.
CREATE UNIQUE INDEX IF NOT EXISTS contact_claims_email_unique
  ON contact_claims (email_normalized)
  WHERE email_normalized <> 'williamxwang03@gmail.com';

-- Lookup index for cleanup cron + observability.
CREATE INDEX IF NOT EXISTS contact_claims_recency
  ON contact_claims (claimed_at DESC);
