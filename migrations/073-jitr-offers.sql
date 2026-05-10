-- migrations/073-jitr-offers.sql
--
-- Renumbered from 038-jitr-offers.sql to resolve a number collision with
-- 038-bench-sim.sql. The original 038-jitr-offers was hand-applied to prod
-- (jitr_offers is already used by app code), so this re-run must be a no-op
-- on prod and only meaningful for fresh-DB rebuilds.
-- See SMOKE_TEST_REPORT_2026-05-09.md finding #28.
--
-- 1. SCHEMA CHANGE
-- New table jitr_offers: tracks Just-In-Time Rep Ratifier offers sent
-- via Lark. One row per (pattern_id, rep_id) attempt, with the
-- rep's decision (accept/dismiss/no_response) and a window so we
-- don't re-offer the same pattern to the same rep daily.
--
-- Why a separate table: prompt_drift_patterns.status is org-scoped
-- ('pending'/'accepted'/'ignored'). A pattern can be accepted by
-- Chenyu but dismissed by Leo. Per-rep state needs its own row.
--
-- 2. WHO WRITES THIS?
-- scripts/jitr-tick.mjs (offer creation) and src/lib/lark-agent.ts
-- (decision recording when a rep clicks the Lark card button).
--
-- 3. WHO READS THIS?
-- scripts/jitr-tick.mjs (idempotency: skip pattern if rep already
-- offered within last 14 days). Future admin dashboard for audit.
--
-- 4. BACKFILL FOR OLD ROWS
-- (d) not applicable — new table, history starts now. Re-running this
-- migration on prod (where the table already exists from the original
-- hand-applied 038) is a no-op thanks to CREATE TABLE IF NOT EXISTS
-- and CREATE [UNIQUE] INDEX IF NOT EXISTS guards below.
--
-- Reference: docs/EXTERNAL_BRIEF.md "Minimum Viable Congress"

create table if not exists jitr_offers (
  id              uuid primary key default gen_random_uuid(),
  pattern_id      integer not null references prompt_drift_patterns(id) on delete cascade,
  rep_id          integer not null references sales_reps(id) on delete cascade,
  offered_at      timestamptz not null default now(),
  -- The Lark message_id of the card we sent. Used to wire callbacks
  -- back to the right offer when the user clicks a button.
  card_message_id text,
  decision        text not null default 'pending'
                  check (decision in ('pending','accept','dismiss','no_response','reverted')),
  decided_at      timestamptz,
  -- Snapshot the pattern at offer time so even if the pattern row
  -- gets edited later, we know what the rep was shown.
  ai_phrase       text not null,
  sales_phrase    text not null,
  occurrence_count integer not null,
  -- Free-form notes if the rep replies in chat instead of clicking
  notes           text,
  -- Stop-loss tracking. When decision='accept', applied_at marks the
  -- moment the rep's template was patched; sends_after_apply counts
  -- emails sent AFTER that. The stop-loss sweep watches:
  --   - first 30 sends_after_apply: if 0 opens AND 0 clicks → revert
  --   - 14 days OR 50 sends, whichever comes first: graduate to
  --     "ready_for_global_proposal" so admin can promote org-wide
  applied_at        timestamptz,
  reverted_at       timestamptz,
  reverted_reason   text,
  promoted_global_at timestamptz
);

create unique index if not exists uniq_jitr_pattern_rep_offer
  on jitr_offers (pattern_id, rep_id, offered_at);
create index if not exists idx_jitr_card_message_id
  on jitr_offers (card_message_id) where card_message_id is not null;
create index if not exists idx_jitr_pending
  on jitr_offers (rep_id, offered_at desc) where decision = 'pending';

notify pgrst, 'reload schema';
