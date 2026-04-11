import { NextResponse } from "next/server";
import { supabase } from "@/lib/db";

export async function POST() {
  const results: string[] = [];

  // 1. sales_reps table
  const { error: e1 } = await supabase.rpc("exec_sql", {
    sql: `
      CREATE TABLE IF NOT EXISTS sales_reps (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        sender_email TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        wechat_id TEXT NOT NULL,
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `,
  });
  results.push(e1 ? `sales_reps: ${e1.message}` : "sales_reps: OK");

  // 2. system_config table
  const { error: e2 } = await supabase.rpc("exec_sql", {
    sql: `
      CREATE TABLE IF NOT EXISTS system_config (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT now()
      );
    `,
  });
  results.push(e2 ? `system_config: ${e2.message}` : "system_config: OK");

  // 3. Add columns to pipeline_leads
  const columns = [
    { name: "s2_author_id", type: "TEXT" },
    { name: "h_index", type: "INTEGER" },
    { name: "citation_count", type: "INTEGER" },
    { name: "paper_count", type: "INTEGER" },
    { name: "lead_tier", type: "TEXT DEFAULT 'normal'" },
    { name: "assigned_rep_id", type: "INTEGER" },
  ];

  for (const col of columns) {
    const { error } = await supabase.rpc("exec_sql", {
      sql: `ALTER TABLE pipeline_leads ADD COLUMN IF NOT EXISTS ${col.name} ${col.type};`,
    });
    results.push(error ? `${col.name}: ${error.message}` : `${col.name}: OK`);
  }

  // 4. Seed Leo as first rep
  const { error: e3 } = await supabase
    .from("sales_reps")
    .upsert(
      {
        id: 1,
        name: "Leo",
        sender_email: "leo@compute.miracleplus.com",
        sender_name: "Leo",
        wechat_id: "Lorenserus1",
        active: true,
      },
      { onConflict: "id" },
    );
  results.push(e3 ? `seed leo: ${e3.message}` : "seed leo: OK");

  // 5. Seed default assignment config
  const defaultConfig = {
    strong_criteria: {
      min_h_index: 20,
      max_school_tier: 2,
      require_overseas: true,
    },
    assignment: {
      strong: { rep_id: 1 },
      normal: { rep_ids: [1], mode: "round_robin" },
    },
  };

  const { error: e4 } = await supabase
    .from("system_config")
    .upsert(
      { key: "lead_assignment", value: defaultConfig },
      { onConflict: "key" },
    );
  results.push(e4 ? `seed config: ${e4.message}` : "seed config: OK");

  return NextResponse.json({ results });
}
