-- migrations/085-lark-webhook-trace.sql
--
-- 1. SCHEMA CHANGE
-- New table `lark_webhook_trace`: raw capture of every Lark POST to
-- /api/lark/webhook. Columns: id (uuid PK), received_at (timestamptz),
-- event_type (text), is_card_action (boolean), operator_open_id (text),
-- action_value (jsonb), header (jsonb), event (jsonb), processed (text
-- nullable — name of branch the dispatcher took), error (text nullable).
-- Index on received_at desc for "recent activity" queries.
--
-- 2. WHO WRITES THIS?
-- src/app/api/lark/webhook/route.ts:POST inserts one row per request
-- right after the JSON parse, BEFORE the dispatcher branches. The insert
-- is fire-and-forget (no await on the response path) so it can't
-- slow URL-verification or card_action ack.
--
-- 3. WHO READS THIS?
-- - /api/admin/recent-card-activity (this PR) joins it in for live
--   debugging when "did my click reach the server" is the question.
-- - Future: a /admin/lark-trace page if we end up needing one.
-- - Ad-hoc: `select * from lark_webhook_trace order by received_at
--   desc limit 50` is the canonical "what's Lark sending us" view.
--
-- 4. BACKFILL FOR OLD ROWS
-- (d) not applicable — new table, no concept of pre-existing webhook
-- events. We start capturing from deploy time forward.

create table if not exists lark_webhook_trace (
  id uuid primary key default gen_random_uuid(),
  received_at timestamptz not null default now(),
  event_type text,
  is_card_action boolean not null default false,
  operator_open_id text,
  action_value jsonb,
  header jsonb,
  event jsonb,
  processed text,
  error text
);

create index if not exists lark_webhook_trace_received_at_idx
  on lark_webhook_trace (received_at desc);

create index if not exists lark_webhook_trace_card_idx
  on lark_webhook_trace (is_card_action, received_at desc)
  where is_card_action = true;
