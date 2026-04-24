import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";

/**
 * POST /api/migrate/scorer
 * Creates the scorer_runs table by inserting and deleting a dummy row.
 * Supabase auto-creates tables when you use the admin API.
 *
 * Actually, Supabase doesn't auto-create tables. We need _exec_sql or
 * direct SQL. Let's try creating via the REST API by checking if the
 * table exists first.
 *
 * ADMIN ONLY. Previously unauth.
 */
export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;
  // Try to query the table — if it exists, we're done
  const { error: checkError } = await supabase
    .from("scorer_runs")
    .select("id")
    .limit(1);

  if (!checkError) {
    return NextResponse.json({ status: "table already exists" });
  }

  // Table doesn't exist — try _exec_sql
  const sql = `create table if not exists scorer_runs (
    id text primary key default gen_random_uuid()::text,
    embedder text not null,
    n_samples int not null,
    n_positive int not null,
    n_negative int not null,
    cv_f1 float not null,
    cv_f1_std float,
    cv_precision float,
    cv_recall float,
    cv_auc float,
    label_distribution jsonb,
    score_distribution jsonb,
    gemini_vs_scorer jsonb,
    trained_at timestamptz not null,
    created_at timestamptz not null default now()
  )`;

  const { error: execError } = await supabase.rpc("_exec_sql", { sql_text: sql });

  if (execError) {
    return NextResponse.json({
      status: "failed",
      error: execError.message,
      hint: "Run this SQL manually in Supabase SQL Editor",
      sql,
    }, { status: 500 });
  }

  return NextResponse.json({ status: "created" });
}
