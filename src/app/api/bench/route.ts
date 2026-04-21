import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";
import { benchOneModel, listKnownModels } from "@/lib/bench";

export const maxDuration = 300;

// GET /api/bench → list known models + all historical runs (per-model averages).
export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const { data: rows } = await supabase
    .from("model_bench_runs")
    .select("model, task, score, latency_s, tokens_in, tokens_out, json_valid, error, created_at, run_id, judge_avg, prompt_leak")
    .order("created_at", { ascending: false })
    .limit(2000);

  // Aggregate by model+task (most recent run per model)
  const byRun = new Map<string, typeof rows>();
  for (const r of rows ?? []) {
    const k = r.run_id as string;
    if (!byRun.has(k)) byRun.set(k, []);
    byRun.get(k)!.push(r);
  }

  return NextResponse.json({
    models: listKnownModels(),
    runs: Array.from(byRun.entries()).map(([runId, items]) => ({
      runId,
      createdAt: items?.[0]?.created_at ?? null,
      models: aggregateByModel(items ?? []),
    })),
  });
}

function aggregateByModel(rows: Array<Record<string, unknown>>) {
  const byModel = new Map<string, { analyze: number[]; intro: number[]; lat: number[]; tin: number[]; tout: number[]; errs: number; jsonOk: number; jsonTot: number; judgeAnalyze: number[]; judgeIntro: number[]; leaks: number }>();
  for (const r of rows) {
    const m = r.model as string;
    const e = byModel.get(m) ?? { analyze: [], intro: [], lat: [], tin: [], tout: [], errs: 0, jsonOk: 0, jsonTot: 0, judgeAnalyze: [], judgeIntro: [], leaks: 0 };
    if (r.error) e.errs++;
    if (r.prompt_leak === true) e.leaks++;
    e.lat.push(Number(r.latency_s) || 0);
    e.tin.push(Number(r.tokens_in) || 0);
    e.tout.push(Number(r.tokens_out) || 0);
    const ja = r.judge_avg == null ? null : Number(r.judge_avg);
    if (r.task === "analyze") {
      e.analyze.push(Number(r.score) || 0);
      e.jsonTot++;
      if (r.json_valid) e.jsonOk++;
      if (ja !== null && !isNaN(ja)) e.judgeAnalyze.push(ja);
    } else if (r.task === "intro") {
      e.intro.push(Number(r.score) || 0);
      if (ja !== null && !isNaN(ja)) e.judgeIntro.push(ja);
    }
    byModel.set(m, e);
  }
  const avg = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  return Array.from(byModel.entries()).map(([model, s]) => ({
    model,
    analyzeAvg: Math.round(avg(s.analyze) * 100) / 100,
    introAvg: Math.round(avg(s.intro) * 100) / 100,
    judgeAnalyzeAvg: s.judgeAnalyze.length ? Math.round(avg(s.judgeAnalyze) * 10) / 10 : null,
    judgeIntroAvg: s.judgeIntro.length ? Math.round(avg(s.judgeIntro) * 10) / 10 : null,
    latencyAvg: Math.round(avg(s.lat) * 10) / 10,
    tokensInAvg: Math.round(avg(s.tin)),
    tokensOutAvg: Math.round(avg(s.tout)),
    jsonValidPct: s.jsonTot > 0 ? Math.round((s.jsonOk / s.jsonTot) * 100) : null,
    errors: s.errs,
    promptLeaks: s.leaks,
  })).sort((a, b) => {
    // Prefer judge-averaged ranking when available
    const ja = (a.judgeAnalyzeAvg ?? 0) + (a.judgeIntroAvg ?? 0);
    const jb = (b.judgeAnalyzeAvg ?? 0) + (b.judgeIntroAvg ?? 0);
    if (ja !== jb) return jb - ja;
    return (b.analyzeAvg + b.introAvg) - (a.analyzeAvg + a.introAvg);
  });
}

// POST /api/bench { models: ["glm-4.7", ...], runId? } → run benchmark.
// If the request includes runId, it appends to an existing run (so the
// client can fan out one model per request — sidesteps the 5-min Vercel
// limit and lets the UI show progress as each model lands).
export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const body = await req.json().catch(() => ({}));
  const requested: string[] = Array.isArray(body.models) && body.models.length > 0
    ? body.models
    : listKnownModels();

  const runId: string = body.runId
    ?? `run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  const results = await Promise.allSettled(
    requested.map((m) => benchOneModel(m, runId)),
  );
  const perModel = requested.map((model, i) => {
    const res = results[i];
    if (res.status === "fulfilled") {
      const rows = res.value;
      const analyze = rows.filter((r) => r.task === "analyze").map((r) => r.score);
      const intro = rows.filter((r) => r.task === "intro").map((r) => r.score);
      const lats = rows.map((r) => r.latency_s);
      return {
        model,
        analyzeAvg: average(analyze),
        introAvg: average(intro),
        latencyAvg: average(lats),
        errors: rows.filter((r) => r.error).length,
        rows: rows.length,
      };
    }
    return { model, error: String(res.reason).slice(0, 200), rows: 0 };
  });

  return NextResponse.json({ runId, perModel });
}

const average = (xs: number[]) =>
  xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : 0;
