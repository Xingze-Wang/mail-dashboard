import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";

export async function GET(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;
  const { runId } = await params;

  const { data, error } = await supabase
    .from("model_bench_runs")
    .select("*")
    .eq("run_id", runId)
    .order("model")
    .order("task")
    .order("sample_idx");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ runId, rows: data ?? [] });
}
