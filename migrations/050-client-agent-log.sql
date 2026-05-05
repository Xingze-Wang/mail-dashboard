-- migrations/050-client-agent-log.sql
-- 1. SCHEMA CHANGE
-- client_agent_log records every draft the client-facing bot produces
-- and the guardrail's verdict. Suppressed drafts are gold dust — they
-- show what the bot wanted to say that we caught.
--
-- 2. WHO WRITES   draftClientReply() in client-agent.ts (best-effort)
-- 3. WHO READS    /admin/client-agent-log (analysis), guardrail tuning
-- 4. BACKFILL     none

create table if not exists client_agent_log (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  channel text not null check (channel in ('lark', 'wechat', 'email')),
  user_message text not null,
  draft_text text not null,
  guard_verdict text not null check (guard_verdict in ('send', 'suppress')),
  guard_reason text,
  draft_latency_ms integer,
  guard_latency_ms integer,
  created_at timestamptz not null default now()
);

create index if not exists client_agent_log_client_time on client_agent_log(client_id, created_at desc);
create index if not exists client_agent_log_verdict_time on client_agent_log(guard_verdict, created_at desc);
