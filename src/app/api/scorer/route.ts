import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";

/**
 * GET /api/scorer — returns all training runs for the dashboard
 * POST /api/scorer — upload a new training run from train_scorer.py
 */

export async function GET() {
  const { data: runs } = await supabase
    .from("scorer_runs")
    .select("*")
    .order("trained_at", { ascending: false })
    .limit(50);

  if (!runs || runs.length === 0) {
    return NextResponse.json({ metadata: null, history: [] });
  }

  // Latest run = full metadata
  const latest = runs[0];
  const metadata = {
    embedder: latest.embedder,
    n_samples: latest.n_samples,
    n_positive: latest.n_positive,
    n_negative: latest.n_negative,
    cv_f1_mean: latest.cv_f1,
    cv_f1_std: latest.cv_f1_std,
    cv_precision: latest.cv_precision,
    cv_recall: latest.cv_recall,
    cv_auc: latest.cv_auc,
    trained_at: latest.trained_at,
    label_distribution: latest.label_distribution,
    score_distribution: latest.score_distribution,
    gemini_vs_scorer: latest.gemini_vs_scorer,
  };

  // All runs = history
  const history = runs.map((r) => ({
    trained_at: r.trained_at,
    n_samples: r.n_samples,
    cv_f1: r.cv_f1,
    cv_precision: r.cv_precision,
    cv_recall: r.cv_recall,
    cv_auc: r.cv_auc,
    embedder: r.embedder,
  }));

  return NextResponse.json({ metadata, history });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const { error } = await supabase.from("scorer_runs").insert({
      embedder: body.embedder,
      n_samples: body.n_samples,
      n_positive: body.n_positive,
      n_negative: body.n_negative,
      cv_f1: body.cv_f1_mean,
      cv_f1_std: body.cv_f1_std,
      cv_precision: body.cv_precision,
      cv_recall: body.cv_recall,
      cv_auc: body.cv_auc,
      label_distribution: body.label_distribution,
      score_distribution: body.score_distribution,
      gemini_vs_scorer: body.gemini_vs_scorer,
      trained_at: body.trained_at,
    });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to save scorer run";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
