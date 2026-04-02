import { NextResponse } from "next/server";
import { supabase } from "@/lib/db";

// One-time setup: creates tables via individual SQL statements
// Hit POST /api/setup once after first deploy
export async function POST() {
  const statements = [
    `create table if not exists emails (
      id uuid primary key default gen_random_uuid(),
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
    )`,
    `create index if not exists idx_emails_thread_id on emails(thread_id)`,
    `create index if not exists idx_emails_to on emails("to")`,
    `create index if not exists idx_emails_status on emails(status)`,
    `create index if not exists idx_emails_created_at on emails(created_at)`,
    `create table if not exists inbound_emails (
      id uuid primary key default gen_random_uuid(),
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
    )`,
    `create index if not exists idx_inbound_thread_id on inbound_emails(thread_id)`,
    `create index if not exists idx_inbound_from on inbound_emails("from")`,
    `create index if not exists idx_inbound_created_at on inbound_emails(created_at)`,
    `create table if not exists templates (
      id uuid primary key default gen_random_uuid(),
      name text not null,
      subject text not null,
      html text not null,
      "text" text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )`,
    `create table if not exists webhook_events (
      id uuid primary key default gen_random_uuid(),
      email_id uuid references emails(id),
      type text not null,
      payload text not null,
      created_at timestamptz not null default now()
    )`,
    `create index if not exists idx_webhook_email_id on webhook_events(email_id)`,
    `create index if not exists idx_webhook_type on webhook_events(type)`,
    `create index if not exists idx_webhook_created_at on webhook_events(created_at)`,
  ];

  const results = [];
  for (const sql of statements) {
    const { error } = await supabase.rpc("_exec_sql", { sql_text: sql });
    results.push({
      sql: sql.slice(0, 80) + "...",
      status: error ? "error" : "ok",
      error: error?.message,
    });
  }

  return NextResponse.json({ results });
}

export async function GET() {
  return NextResponse.json({
    message: "POST to this endpoint to run database setup. First create the _exec_sql function in Supabase SQL Editor.",
    instructions: [
      "1. Go to Supabase SQL Editor",
      "2. Run: CREATE OR REPLACE FUNCTION _exec_sql(sql_text text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN EXECUTE sql_text; END; $$;",
      "3. POST to /api/setup",
    ],
  });
}
