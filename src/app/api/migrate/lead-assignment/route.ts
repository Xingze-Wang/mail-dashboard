import { NextResponse } from "next/server";

async function execSQL(sql: string): Promise<{ ok: boolean; error?: string }> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_KEY!;

  // Use Supabase's pg REST endpoint for raw SQL
  const res = await fetch(`${url}/rest/v1/rpc/`, {
    method: "POST",
    headers: {
      "apikey": key,
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });

  // If RPC doesn't work, fall back to the SQL API
  // Supabase exposes /pg/query for service role
  const sqlRes = await fetch(`${url}/sql`, {
    method: "POST",
    headers: {
      "apikey": key,
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: sql }),
  });

  if (sqlRes.ok) return { ok: true };

  // Try another approach — use the PostgREST function endpoint
  const altRes = await fetch(`${url}/rest/v1/rpc/_exec_sql`, {
    method: "POST",
    headers: {
      "apikey": key,
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
      "Prefer": "return=minimal",
    },
    body: JSON.stringify({ sql_text: sql }),
  });

  if (altRes.ok) return { ok: true };

  return { ok: false, error: `HTTP ${sqlRes.status}: ${await sqlRes.text()}` };
}

export async function POST() {
  // Instead of trying to run DDL through the API (which often fails),
  // return the SQL statements the user needs to run in the Supabase SQL editor
  const sql = `
-- 1. Create sales_reps table
CREATE TABLE IF NOT EXISTS sales_reps (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  sender_email TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  wechat_id TEXT NOT NULL,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Create system_config table
CREATE TABLE IF NOT EXISTS system_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 3. Add columns to pipeline_leads
ALTER TABLE pipeline_leads ADD COLUMN IF NOT EXISTS s2_author_id TEXT;
ALTER TABLE pipeline_leads ADD COLUMN IF NOT EXISTS h_index INTEGER;
ALTER TABLE pipeline_leads ADD COLUMN IF NOT EXISTS citation_count INTEGER;
ALTER TABLE pipeline_leads ADD COLUMN IF NOT EXISTS paper_count INTEGER;
ALTER TABLE pipeline_leads ADD COLUMN IF NOT EXISTS lead_tier TEXT DEFAULT 'normal';
ALTER TABLE pipeline_leads ADD COLUMN IF NOT EXISTS assigned_rep_id INTEGER;

-- 4. Seed Leo as first rep
INSERT INTO sales_reps (id, name, sender_email, sender_name, wechat_id, active)
VALUES (1, 'Leo', 'leo@compute.miracleplus.com', 'Leo', 'Lorenserus1', true)
ON CONFLICT (id) DO NOTHING;

-- 5. Seed default assignment config
INSERT INTO system_config (key, value)
VALUES ('lead_assignment', '{"strong_criteria":{"min_h_index":20,"max_school_tier":2,"require_overseas":true},"assignment":{"strong":{"rep_id":1},"normal":{"rep_ids":[1],"mode":"round_robin"}}}')
ON CONFLICT (key) DO NOTHING;
`;

  // Try to execute via the SQL API
  const result = await execSQL(sql);

  if (result.ok) {
    return NextResponse.json({ status: "ok", message: "Migration complete" });
  }

  // If it fails, return the SQL for manual execution
  return NextResponse.json({
    status: "manual_required",
    message: "Could not run DDL via API. Please run this SQL in the Supabase SQL Editor (supabase.com → your project → SQL Editor):",
    sql,
  });
}
