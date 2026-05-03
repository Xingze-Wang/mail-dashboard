import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";
import { benchCongressOneModel, CONGRESS_SAMPLES } from "@/lib/bench-congress";
import { listKnownModels } from "@/lib/bench";

export const maxDuration = 300;

// GET /api/bench/congress → leaderboard (congress task rows only)
export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const { data: rows } = await supabase
    .from("model_bench_runs")
    .select("model, task, score, latency_s, tokens_in, tokens_out, json_valid, error, created_at, run_id, output_text")
    .eq("task", "congress")
    .order("created_at", { ascending: false })
    .limit(1000);

  const byRun = new Map<string, typeof rows>();
  for (const r of rows ?? []) {
    const k = r.run_id as string;
    if (!byRun.has(k)) byRun.set(k, []);
    byRun.get(k)!.push(r);
  }

  return NextResponse.json({
    models: listKnownModels(),
    sampleCount: CONGRESS_SAMPLES.length,
    runs: Array.from(byRun.entries()).map(([runId, items]) => ({
      runId,
      createdAt: items?.[0]?.created_at ?? null,
      models: aggregateByModel(items ?? []),
    })),
  });
}

function aggregateByModel(rows: Array<Record<string, unknown>>) {
  const byModel = new Map<string, { scores: number[]; lat: number[]; errs: number; jsonOk: number; jsonTot: number }>();
  for (const r of rows) {
    const m = r.model as string;
    const e = byModel.get(m) ?? { scores: [], lat: [], errs: 0, jsonOk: 0, jsonTot: 0 };
    if (r.error) e.errs++;
    e.lat.push(Number(r.latency_s) || 0);
    e.scores.push(Number(r.score) || 0);
    e.jsonTot++;
    if (r.json_valid) e.jsonOk++;
    byModel.set(m, e);
  }
  const avg = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  return Array.from(byModel.entries()).map(([model, s]) => ({
    model,
    scoreAvg: Math.round(avg(s.scores) * 100) / 100,
    latencyAvg: Math.round(avg(s.lat) * 10) / 10,
    jsonValidPct: s.jsonTot > 0 ? Math.round((s.jsonOk / s.jsonTot) * 100) : null,
    errors: s.errs,
    runs: s.scores.length,
  })).sort((a, b) => b.scoreAvg - a.scoreAvg);
}

// POST /api/bench/congress { models: [...], runId? }
export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const body = await req.json().catch(() => ({}));
  const requested: string[] = Array.isArray(body.models) && body.models.length > 0
    ? body.models
    : listKnownModels();

  const runId: string = body.runId
    ?? `crun_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  const results = await Promise.allSettled(
    requested.map((m) => benchCongressOneModel(m, runId)),
  );

  const perModel = requested.map((model, i) => {
    const res = results[i];
    if (res.status === "fulfilled") {
      const rows = res.value;
      const scores = rows.map((r) => r.score);
      return { model, scoreAvg: scores.reduce((a, b) => a + b, 0) / (scores.length || 1), rows: rows.length };
    }
    return { model, error: String(res.reason).slice(0, 200), rows: 0 };
  });

  return NextResponse.json({ runId, perModel });
}
