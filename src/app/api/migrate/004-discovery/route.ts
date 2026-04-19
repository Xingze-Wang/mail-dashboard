import { NextResponse } from "next/server";
import { supabase } from "@/lib/db";

/**
 * POST /api/migrate/004-discovery
 *
 * Idempotent check that the discovery_leads + scan_state tables exist.
 * Mirrors the pattern in /api/migrate/add-ethan: we don't actually run
 * DDL through the API (Supabase service role can't run DDL via REST).
 * Instead we probe the tables and, if missing, return the SQL for the
 * user to paste into the Supabase SQL Editor.
 */
export async function POST() {
  const checks: Array<{ table: string; ok: boolean; error?: string }> = [];

  for (const table of ["discovery_leads", "scan_state"] as const) {
    const { error } = await supabase.from(table).select("*").limit(1);
    checks.push({
      table,
      ok: !error,
      error: error?.message,
    });
  }

  const missing = checks.filter((c) => !c.ok);

  if (missing.length === 0) {
    return NextResponse.json({
      status: "ok",
      message: "discovery_leads and scan_state already exist",
      checks,
    });
  }

  // SQL kept in sync with migrations/004-discovery-leads.sql
  const sql = `create table if not exists discovery_leads (
  id           bigserial primary key,
  source       text not null,
  external_id  text not null,
  score        real not null default 0,
  signals      jsonb not null default '{}',
  profile_url  text,
  fullname     text,
  location     text,
  org          text,
  bio          text,
  contact_hint text,
  email        text,
  promoted_at  timestamptz,
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now(),
  hit_count    int not null default 1,
  unique (source, external_id)
);
create index if not exists idx_discovery_source_score on discovery_leads (source, score desc);
create index if not exists idx_discovery_last_seen on discovery_leads (last_seen desc);
create index if not exists idx_discovery_email_null on discovery_leads (source) where email is null;

create table if not exists scan_state (
  scan_type        text primary key,
  cursor_timestamp timestamptz,
  cursor_token     text,
  last_run_at      timestamptz
);`;

  return NextResponse.json(
    {
      status: "manual_required",
      message:
        "Could not verify tables. Paste this SQL into Supabase SQL Editor (supabase.com → project → SQL Editor):",
      checks,
      sql,
    },
    { status: 500 },
  );
}
