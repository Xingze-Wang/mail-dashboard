import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/template-insights
 *
 * Aggregates template_ratings (mig 068) two ways:
 *
 *   1. perTemplate[]: each template that has ≥1 AI + ≥1 human rating.
 *      Returns AI dim scores, mean human dim scores, |gap| per dim,
 *      and a total |gap| (L1 norm across 6 dims) so the UI can sort
 *      by "calibration outlier".
 *
 *   2. perDimension[]: across all templates with both AI + human,
 *      mean AI score and mean human score per dim. Surfaces
 *      systematic AI biases — "AI consistently over-rates politeness
 *      by 2.4 points" → calibration target.
 *
 * Auth: admin only. Sales reps don't need to see internal scoring.
 */

const DIMS = [
  "politeness",
  "clarity",
  "peer_register",
  "brand_fit",
  "factual_accuracy",
  "naturalness",
] as const;
type Dim = typeof DIMS[number];

interface RatingRow {
  template_id: string;
  rater_kind: "ai" | "human";
  rater_id: number | null;
  politeness: number;
  clarity: number;
  peer_register: number;
  brand_fit: number;
  factual_accuracy: number;
  naturalness: number;
  reasoning: string | null;
  updated_at: string;
}

async function requireAdmin(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return null;
  const { data: rep } = await supabase
    .from("sales_reps")
    .select("role")
    .eq("id", session.repId)
    .maybeSingle();
  if (!rep || rep.role !== "admin") return null;
  return session;
}

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const { data: rawRatings } = await supabase
    .from("template_ratings")
    .select("template_id, rater_kind, rater_id, politeness, clarity, peer_register, brand_fit, factual_accuracy, naturalness, reasoning, updated_at");
  const ratings = (rawRatings ?? []) as RatingRow[];

  // Group ratings by template
  const byTemplate = new Map<string, { ai: RatingRow[]; human: RatingRow[] }>();
  for (const r of ratings) {
    const slot = byTemplate.get(r.template_id) ?? { ai: [], human: [] };
    if (r.rater_kind === "ai") slot.ai.push(r);
    else slot.human.push(r);
    byTemplate.set(r.template_id, slot);
  }

  // Pull template metadata for the IDs we have ratings for, so the
  // UI can show name + status + segment without a second round-trip.
  const tplIds = [...byTemplate.keys()];
  const tplMeta = new Map<string, { name: string; status: string; segment_default: string | null }>();
  if (tplIds.length > 0) {
    const { data: tpls } = await supabase
      .from("email_templates")
      .select("id, name, status, segment_default")
      .in("id", tplIds);
    for (const t of tpls ?? []) {
      tplMeta.set(t.id as string, {
        name: t.name as string,
        status: t.status as string,
        segment_default: (t.segment_default as string | null) ?? null,
      });
    }
  }

  // perTemplate aggregation
  const perTemplate: Array<{
    template_id: string;
    template_name: string;
    template_status: string;
    template_segment: string | null;
    ai: Record<Dim, number> | null;
    human_mean: Record<Dim, number> | null;
    n_humans: number;
    gap: Record<Dim, number> | null;     // human_mean - ai (signed)
    abs_gap_total: number;                  // sum |human_mean - ai| across dims
    sample_human_reasoning: string | null;
    sample_ai_reasoning: string | null;
  }> = [];

  const meanOf = (rows: RatingRow[], dim: Dim): number => {
    if (rows.length === 0) return NaN;
    return rows.reduce((s, r) => s + r[dim], 0) / rows.length;
  };

  for (const [tplId, { ai, human }] of byTemplate) {
    if (ai.length === 0 || human.length === 0) continue; // need both sides
    const aiRow = ai[0]; // one AI row per template (upserted)
    const meta = tplMeta.get(tplId) ?? { name: "(unknown)", status: "?", segment_default: null };

    const humanMean = Object.fromEntries(
      DIMS.map((d) => [d, meanOf(human, d)]),
    ) as Record<Dim, number>;

    const aiScores = Object.fromEntries(
      DIMS.map((d) => [d, aiRow[d]]),
    ) as Record<Dim, number>;

    const gap = Object.fromEntries(
      DIMS.map((d) => [d, humanMean[d] - aiScores[d]]),
    ) as Record<Dim, number>;

    const absGapTotal = DIMS.reduce((s, d) => s + Math.abs(gap[d]), 0);

    perTemplate.push({
      template_id: tplId,
      template_name: meta.name,
      template_status: meta.status,
      template_segment: meta.segment_default,
      ai: aiScores,
      human_mean: humanMean,
      n_humans: human.length,
      gap,
      abs_gap_total: absGapTotal,
      sample_human_reasoning: human.find((h) => h.reasoning)?.reasoning ?? null,
      sample_ai_reasoning: aiRow.reasoning,
    });
  }

  // Sort by |gap| descending — biggest disagreements at top
  perTemplate.sort((a, b) => b.abs_gap_total - a.abs_gap_total);

  // perDimension aggregation: mean AI vs mean human across all
  // template pairs (only counting templates that have both)
  const perDimension: Array<{
    dimension: Dim;
    n_templates: number;
    ai_mean: number;
    human_mean: number;
    mean_gap: number; // human - ai (signed; positive = humans rate higher)
  }> = [];
  for (const dim of DIMS) {
    const eligible = perTemplate.filter((p) => p.ai !== null && p.human_mean !== null);
    if (eligible.length === 0) {
      perDimension.push({ dimension: dim, n_templates: 0, ai_mean: NaN, human_mean: NaN, mean_gap: NaN });
      continue;
    }
    const aiMean = eligible.reduce((s, p) => s + p.ai![dim], 0) / eligible.length;
    const humanMean = eligible.reduce((s, p) => s + p.human_mean![dim], 0) / eligible.length;
    perDimension.push({
      dimension: dim,
      n_templates: eligible.length,
      ai_mean: aiMean,
      human_mean: humanMean,
      mean_gap: humanMean - aiMean,
    });
  }

  return NextResponse.json({
    perTemplate,
    perDimension,
    totals: {
      n_templates_with_ratings: byTemplate.size,
      n_templates_paired: perTemplate.length,
      n_total_ratings: ratings.length,
    },
  });
}
