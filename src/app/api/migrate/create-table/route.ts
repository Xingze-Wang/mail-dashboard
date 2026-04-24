import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "@/lib/auth-helpers";

/**
 * POST /api/migrate/create-table
 * Body: { sql: "CREATE TABLE ..." }
 *
 * Uses the Supabase Management API to execute raw SQL.
 * Falls back to creating via insert if management API is unavailable.
 *
 * ADMIN ONLY — takes arbitrary SQL from the request body and runs it
 * against the production DB via the Management API. Previously unauth;
 * anyone who found the URL could drop tables, escalate privileges, or
 * exfiltrate data. Gate first, then parse body.
 */
export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;
  const { sql } = await req.json();

  if (!sql) {
    return NextResponse.json({ error: "sql required" }, { status: 400 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY!;

  // Use the Supabase PostgREST client with service role
  const supabase = createClient(supabaseUrl, serviceKey, {
    db: { schema: "public" },
  });

  // Try _exec_sql first
  const { error: rpcError } = await supabase.rpc("_exec_sql", { sql_text: sql });

  if (!rpcError) {
    return NextResponse.json({ status: "ok", method: "rpc" });
  }

  // If _exec_sql doesn't exist, try creating it first then retry
  if (rpcError.message.includes("_exec_sql")) {
    // Try creating the function via a different approach —
    // use the pg_net extension or just return the SQL for manual execution
    return NextResponse.json({
      status: "manual_required",
      error: "_exec_sql function not found",
      sql_to_run: [
        "CREATE OR REPLACE FUNCTION _exec_sql(sql_text text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN EXECUTE sql_text; END; $$;",
        sql,
      ],
    }, { status: 422 });
  }

  return NextResponse.json({ error: rpcError.message }, { status: 500 });
}
