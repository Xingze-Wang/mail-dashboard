import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Direct SQL execution using Supabase's pg_net extension or service role
export async function POST() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY!;

  // Use the REST API to execute SQL via the pg endpoint
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/_exec_sql`, {
    method: "POST",
    headers: {
      "apikey": serviceKey,
      "Authorization": `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sql_text: `
        create table if not exists pipeline_leads (
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
        );
        create index if not exists idx_pipeline_status on pipeline_leads(status);
        create index if not exists idx_pipeline_email on pipeline_leads(author_email);
        create index if not exists idx_pipeline_created on pipeline_leads(created_at);
      `,
    }),
  });

  if (!response.ok) {
    // _exec_sql doesn't exist — try using the Supabase management API instead
    // Fall back to creating the table via individual inserts that will fail, revealing the issue
    const supabase = createClient(supabaseUrl, serviceKey);

    // Try direct SQL via Supabase's built-in SQL endpoint
    const sqlResponse = await fetch(`${supabaseUrl}/pg/query`, {
      method: "POST",
      headers: {
        "apikey": serviceKey,
        "Authorization": `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `create table if not exists pipeline_leads (
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
      }),
    });

    const sqlResult = await sqlResponse.text();
    return NextResponse.json({
      method: "pg_query",
      status: sqlResponse.status,
      result: sqlResult,
    });
  }

  return NextResponse.json({ method: "rpc", status: "ok" });
}
