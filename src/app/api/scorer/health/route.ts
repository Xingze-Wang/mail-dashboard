import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";
import { getConfig } from "@/lib/system-config";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/scorer/health
 *
 * One-shot aggregator for the scorer hero card. Each of the 4
 * scorer tabs has its own data source; this endpoint pulls the
 * "is this healthy?" signal from each so admin sees system-wide
 * model health on landing without clicking through.
 *
 * Per tab, returns:
 *   status: "green" | "yellow" | "red" | "missing"
 *   headline: short one-liner suitable for a tile
 *   details: small dict of numbers (model age, sample count, etc.)
 *
 * Tab-specific signals:
 *   lead       — scorer_runs latest row: AUC + age (red if >30d)
 *   email      — judge_verdicts column on pipeline_leads: how many
 *                drafts judged in last 30d, mean score, prompt-leak rate
 *   conversion — scorer_runs/conversion_models latest: AUC + n_positive
 *                (red if <20 positive, never trained, or stale >30d)
 *   match      — pipeline_leads in last 30d with assigned_rep_id:
 *                misroute count (lead bucket vs strong-criteria thresholds)
 */
export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const now = Date.now();
  const day30Ago = new Date(now - 30 * 86_400_000).toISOString();

  // ── Lead quality ──────────────────────────────────────────────────
  // scorer_runs: latest training. AUC + age.
  let lead;
  {
    const { data: latest } = await supabase
      .from("scorer_runs")
      .select("trained_at, cv_auc, cv_f1, n_samples, n_positive")
      .order("trained_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!latest) {
      lead = {
        status: "missing" as const,
        headline: "Lead-quality scorer never trained",
        details: { trained_at: null, age_days: null, auc: null, samples: null },
      };
    } else {
      const ageMs = now - new Date(latest.trained_at as string).getTime();
      const ageDays = Math.round(ageMs / 86_400_000);
      const auc = (latest.cv_auc as number) ?? 0;
      const status =
        ageDays > 30 ? "red"
        : auc < 0.65 ? "yellow"
        : "green";
      lead = {
        status,
        headline:
          ageDays > 30 ? `Stale: trained ${ageDays}d ago`
          : auc < 0.65 ? `Low AUC ${auc.toFixed(2)} on ${latest.n_samples} samples`
          : `AUC ${auc.toFixed(2)} on ${latest.n_samples} samples (${ageDays}d ago)`,
        details: {
          trained_at: latest.trained_at,
          age_days: ageDays,
          auc,
          f1: latest.cv_f1,
          samples: latest.n_samples,
          positives: latest.n_positive,
        },
      };
    }
  }

  // ── Email quality (judge ensemble on drafts) ──────────────────────
  // judge_avg lives on pipeline_leads (migration 008). 30d window.
  let email;
  {
    const { data: judged } = await supabase
      .from("pipeline_leads")
      .select("judge_avg, judge_prompt_leak, judge_at")
      .gte("judge_at", day30Ago)
      .not("judge_avg", "is", null);
    const total = judged?.length ?? 0;
    if (total === 0) {
      email = {
        status: "yellow" as const,
        headline: "No drafts judged in last 30d",
        details: { total: 0, mean_score: null, leak_rate: null },
      };
    } else {
      const mean = judged!.reduce((s, j) => s + ((j.judge_avg as number) ?? 0), 0) / total;
      const leaks = judged!.filter((j) => j.judge_prompt_leak === true).length;
      const leakRate = leaks / total;
      const status =
        mean < 5 || leakRate > 0.05 ? "red"
        : mean < 7 ? "yellow"
        : "green";
      email = {
        status,
        headline: leakRate > 0.05
          ? `Prompt-leak rate ${(leakRate * 100).toFixed(1)}% (>5% threshold)`
          : mean < 5 ? `Mean score ${mean.toFixed(1)}/10 — quality dropped`
          : `Mean ${mean.toFixed(1)}/10 over ${total} drafts (leak ${(leakRate * 100).toFixed(1)}%)`,
        details: { total, mean_score: Number(mean.toFixed(2)), leak_rate: Number(leakRate.toFixed(3)) },
      };
    }
  }

  // ── Conversion model ──────────────────────────────────────────────
  // Persisted in system_config under key "active_conversion_model"
  // (see src/app/api/scorer/conversion-model/route.ts). Stale if >30d,
  // weak if n_positive < 20.
  let conversion;
  {
    const model = await getConfig<{ trained_at?: string; auc?: number; nSamples?: number; nPositive?: number }>(
      "active_conversion_model",
    );
    if (!model || !model.trained_at) {
      conversion = {
        status: "missing" as const,
        headline: "Conversion model never trained",
        details: { trained_at: null, age_days: null, auc: null, n_positive: null },
      };
    } else {
      const ageMs = now - new Date(model.trained_at).getTime();
      const ageDays = Math.round(ageMs / 86_400_000);
      const auc = model.auc ?? 0;
      const nPos = model.nPositive ?? 0;
      const status =
        ageDays > 30 ? "red"
        : nPos < 20 ? "yellow"
        : auc < 0.6 ? "yellow"
        : "green";
      conversion = {
        status,
        headline:
          ageDays > 30 ? `Stale: trained ${ageDays}d ago`
          : nPos < 20 ? `Only ${nPos} positives — feature weights are noise`
          : `AUC ${auc.toFixed(2)}, ${nPos} positives (${ageDays}d ago)`,
        details: { trained_at: model.trained_at, age_days: ageDays, auc, n_positive: nPos, n_samples: model.nSamples ?? null },
      };
    }
  }

  // ── Sales match (rep routing audit) ──────────────────────────────
  // Reuse misrouted-detection logic from /api/scorer/match: a lead is
  // mis-routed when its features look "strong" but it landed with a
  // junior. We approximate cheaply here: count sent leads in 30d
  // where citation_count >= 100 OR h_index >= 20 but assigned_rep_id
  // points to a non-senior rep. (Same threshold idea as scorer/match
  // route's strong-criteria; details there.)
  let match;
  {
    const [{ count: total }, { data: strongs }] = await Promise.all([
      supabase
        .from("pipeline_leads")
        .select("*", { count: "exact", head: true })
        .gte("created_at", day30Ago)
        .not("assigned_rep_id", "is", null),
      supabase
        .from("pipeline_leads")
        .select("assigned_rep_id, citation_count, h_index, lead_tier")
        .gte("created_at", day30Ago)
        .or("citation_count.gte.100,h_index.gte.20"),
    ]);
    const totalCount = total ?? 0;
    if (totalCount === 0) {
      match = {
        status: "yellow" as const,
        headline: "No assigned leads in last 30d",
        details: { total: 0, misrouted: 0, misroute_rate: null },
      };
    } else {
      // Reps with role >= senior. Cheap second query — small table.
      const { data: reps } = await supabase
        .from("sales_reps")
        .select("id, role");
      const seniorIds = new Set((reps ?? []).filter((r) => r.role === "senior" || r.role === "admin").map((r) => r.id));
      const misrouted = (strongs ?? []).filter((l) => !seniorIds.has(l.assigned_rep_id as number)).length;
      const rate = totalCount > 0 ? misrouted / totalCount : 0;
      const status =
        rate > 0.15 ? "red"
        : rate > 0.05 ? "yellow"
        : "green";
      match = {
        status,
        headline: rate > 0.15
          ? `${misrouted} strong leads went to junior reps (${(rate * 100).toFixed(0)}% misroute)`
          : `${totalCount} routed in 30d, ${misrouted} potential misroutes`,
        details: { total: totalCount, misrouted, misroute_rate: Number(rate.toFixed(3)) },
      };
    }
  }

  return NextResponse.json({ lead, email, conversion, match });
}
