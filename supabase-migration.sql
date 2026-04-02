-- Run this in your Supabase SQL Editor: https://supabase.com/dashboard/project/erguqrisqtugfysofwdd/sql/new

create table if not exists emails (
  id text primary key default gen_random_uuid()::text,
  "from" text not null,
  "to" text not null,
  subject text not null,
  html text not null default '',
  "text" text,
  resend_id text unique,
  status text not null default 'queued',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  in_reply_to text,
  "references" text,
  message_id text unique,
  thread_id text
);

create index if not exists idx_emails_thread_id on emails(thread_id);
create index if not exists idx_emails_to on emails("to");
create index if not exists idx_emails_status on emails(status);
create index if not exists idx_emails_created_at on emails(created_at);

create table if not exists inbound_emails (
  id text primary key default gen_random_uuid()::text,
  "from" text not null,
  "to" text not null default '',
  subject text not null default '(no subject)',
  html text,
  "text" text,
  message_id text unique,
  in_reply_to text,
  "references" text,
  thread_id text,
  headers text,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_inbound_thread_id on inbound_emails(thread_id);
create index if not exists idx_inbound_from on inbound_emails("from");
create index if not exists idx_inbound_created_at on inbound_emails(created_at);

create table if not exists templates (
  id text primary key default gen_random_uuid()::text,
  name text not null,
  subject text not null,
  html text not null,
  "text" text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists webhook_events (
  id text primary key default gen_random_uuid()::text,
  email_id text references emails(id),
  type text not null,
  payload text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_webhook_email_id on webhook_events(email_id);
create index if not exists idx_webhook_type on webhook_events(type);
create index if not exists idx_webhook_created_at on webhook_events(created_at);

create table if not exists api_keys (
  id text primary key default gen_random_uuid()::text,
  name text not null,
  key text unique not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
