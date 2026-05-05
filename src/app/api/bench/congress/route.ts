import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";
import { runAllConfigsOnSample, CONGRESS_CONFIGS, CONGRESS_SAMPLES } from "@/lib/bench-congress";

export const maxDuration = 300;

// GET /api/bench/congress → all congress_config runs grouped by run_id + sample
export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const { data: rows } = await supabase
    .from("model_bench_runs")
    .select("run_id, model, task, sample_idx, score, latency_s, tokens_out, json_valid, error, created_at, output_text")
    .eq("task", "congress_config")
    .order("created_at", { ascending: false })
    .limit(500);

  // Group: run_id → sample_idx → config rows
  const byRun = new Map<string, { createdAt: string; samples: Map<number, typeof rows> }>();
  for (const r of rows ?? []) {
    const k = r.run_id as string;
    if (!byRun.has(k)) byRun.set(k, { createdAt: r.created_at as string, samples: new Map() });
    const idx = Number(r.sample_idx);
    const entry = byRun.get(k)!;
    if (!entry.samples.has(idx)) entry.samples.set(idx, []);
    entry.samples.get(idx)!.push(r);
  }

  const runs = Array.from(byRun.entries()).map(([runId, { createdAt, samples }]) => ({
    runId,
    createdAt,
    samples: Array.from(samples.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([sampleIdx, configRows]) => ({
        sampleIdx,
        sampleTitle: CONGRESS_SAMPLES[sampleIdx]?.title ?? `Sample ${sampleIdx}`,
        configs: (configRows ?? []).map((r) => {
          let parsed: Record<string, unknown> = {};
          try { parsed = JSON.parse(r.output_text as string); } catch { /* leave empty */ }
          return {
            configId: parsed.configId as string ?? (r.model as string).split("/")[0].replace("congress:", ""),
            configName: parsed.configName as string ?? r.model,
            recommendation: parsed.recommendation as string ?? null,
            confidence: parsed.confidence as number ?? null,
            change: parsed.change as { kind: string; details: string } | null ?? null,
            rationale: parsed.rationale as string ?? null,
            extraFields: (parsed.extraFields as Record<string, string>) ?? {},
            personas: (parsed.personas as Record<string, string>) ?? {},
            latency_s: Number(r.latency_s),
            error: r.error as string | null,
          };
        }),
      })),
  }));

  return NextResponse.json({
    configs: CONGRESS_CONFIGS.map((c) => ({ id: c.id, name: c.name, tagline: c.tagline, color: c.color, model: c.model })),
    samples: CONGRESS_SAMPLES.map((s) => ({ id: s.id, title: s.title })),
    runs,
  });
}

// POST /api/bench/congress { sampleId?: string } → run all configs on one sample
export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const body = await req.json().catch(() => ({}));
  const sampleId = typeof body.sampleId === "string" ? body.sampleId : null;
  const sample = sampleId
    ? CONGRESS_SAMPLES.find((s) => s.id === sampleId) ?? CONGRESS_SAMPLES[0]
    : CONGRESS_SAMPLES[0];

  const runId: string = body.runId ?? `crun_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  const results = await runAllConfigsOnSample(sample, runId);

  return NextResponse.json({
    runId,
    sampleId: sample.id,
    sampleTitle: sample.title,
    configs: results.map((r) => ({
      configId: r.configId,
      configName: r.configName,
      recommendation: r.recommendation,
      confidence: r.confidence,
      change: r.change,
      rationale: r.rationale,
    })),
  });
}
