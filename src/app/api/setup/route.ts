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
    `create table if not exists pipeline_leads (
      id text primary key default gen_random_uuid()::text,
      arxiv_id text unique not null,
      title text not null,
      abstract text,
      authors text,
      pdf_url text,
      published_at timestamptz,
      author_name text,
      author_email text not null,
      first_name text,
      school_name text,
      school_tier int,
      compute_level text,
      compute_confidence float,
      compute_reason text,
      matched_directions text,
      draft_subject text,
      draft_html text,
      status text not null default 'new',
      source text not null default 'arxiv',
      created_at timestamptz not null default now(),
      sent_at timestamptz
    )`,
    `create index if not exists idx_pipeline_status on pipeline_leads(status)`,
    `create index if not exists idx_pipeline_email on pipeline_leads(author_email)`,
    `create index if not exists idx_pipeline_created on pipeline_leads(created_at)`,

    // Paper archive: one row per paper, all authors stored individually
    `create table if not exists papers (
      arxiv_id text primary key,
      title text not null,
      abstract text,
      authors text,
      pdf_url text,
      published_at timestamptz,
      compute_level text,
      compute_confidence float,
      compute_reason text,
      matched_directions text,
      created_at timestamptz not null default now()
    )`,
    `create table if not exists paper_authors (
      id text primary key default gen_random_uuid()::text,
      arxiv_id text not null references papers(arxiv_id),
      author_name text,
      first_name text,
      email text,
      is_chinese boolean default false,
      position int,
      created_at timestamptz not null default now()
    )`,
    `create index if not exists idx_paper_authors_arxiv on paper_authors(arxiv_id)`,
    `create index if not exists idx_paper_authors_name on paper_authors(first_name)`,
    `create index if not exists idx_paper_authors_author on paper_authors(author_name)`,
    `create index if not exists idx_paper_authors_email on paper_authors(email)`,

    // Brief lookups: tracks when sales looked up a name (= someone added on WeChat)
    `create table if not exists brief_lookups (
      id text primary key default gen_random_uuid()::text,
      query text not null,
      arxiv_id text,
      lead_id text,
      added_wechat boolean not null default false,
      wechat_at timestamptz,
      notes text,
      created_at timestamptz not null default now()
    )`,
    `create index if not exists idx_brief_lookups_query on brief_lookups(query)`,
    `create index if not exists idx_brief_lookups_arxiv on brief_lookups(arxiv_id)`,
    `create index if not exists idx_brief_lookups_wechat on brief_lookups(added_wechat)`,
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
