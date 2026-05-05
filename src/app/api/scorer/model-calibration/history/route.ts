// GET /api/scorer/model-calibration/history
//
// Returns persisted calibration runs grouped by model so the UI can
// render a drift chart. Each model's series is ordered oldest → newest.

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

export interface CalibrationRunRow {
  id: string;
  model: string;
  n: number;
  click_accuracy: number;
  wechat_accuracy: number;
  click_brier: number;
  wechat_brier: number;
  click_log_loss: number;
  wechat_log_loss: number;
  avg_latency_s: number;
  errors: number;
  meta: Record<string, unknown>;
  run_at: string;
}

export interface CalibrationHistoryPayload {
  models: Array<{ model: string; runs: CalibrationRunRow[] }>;
  total_runs: number;
  earliest_run_at: string | null;
  latest_run_at: string | null;
}

export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const url = new URL(req.url);
  const lookbackDays = Math.max(1, Math.min(365, Number(url.searchParams.get("days") ?? "90")));
  const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString();

  const { data, error } = await supabase
    .from("model_calibration_runs")
    .select("*")
    .gte("run_at", since)
    .order("run_at", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []) as CalibrationRunRow[];
  const byModel = new Map<string, CalibrationRunRow[]>();
  for (const r of rows) {
    const existing = byModel.get(r.model) ?? [];
    existing.push(r);
    byModel.set(r.model, existing);
  }
  const models = Array.from(byModel.entries())
    .map(([model, runs]) => ({ model, runs }))
    .sort((a, b) => a.model.localeCompare(b.model));

  const payload: CalibrationHistoryPayload = {
    models,
    total_runs: rows.length,
    earliest_run_at: rows[0]?.run_at ?? null,
    latest_run_at: rows[rows.length - 1]?.run_at ?? null,
  };
  return NextResponse.json(payload);
}
