-- migrations/049-helper-artifacts.sql
-- 1. SCHEMA CHANGE
-- helper_artifacts logs every Lark side-effect the bot performs on a
-- rep's behalf — docs created, Bases created, DMs sent. Powers the
-- get_my_artifacts read-tool so the bot can recall "the doc I made you
-- on Tuesday" without recomputing or recreating.
--
-- 2. WHO WRITES   runReadTool's lark cases (after success)
-- 3. WHO READS    get_my_artifacts read-tool
-- 4. BACKFILL     none — empty until first artifact

create table if not exists helper_artifacts (
  id uuid primary key default gen_random_uuid(),
  rep_id integer not null references sales_reps(id) on delete cascade,
  -- "lark_doc" | "lark_base" | "lark_dm" | "lark_chat_msg"
  kind text not null,
  -- One opaque id (document_id, app_token, message_id, etc) so the bot
  -- can hand back a specific reference.
  lark_id text not null,
  -- Human-readable title or first line; what the bot uses to match the
  -- user's question ("the wechat conversion doc").
  title text not null,
  -- A clickable URL when applicable (docs / bases). DMs don't have a
  -- shareable URL; we store the receiver display string.
  url text,
  -- Free-form payload — sender open_id, table_id, message preview, etc.
  meta jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists helper_artifacts_rep_kind_time on helper_artifacts(rep_id, kind, created_at desc);
create index if not exists helper_artifacts_rep_time on helper_artifacts(rep_id, created_at desc);
