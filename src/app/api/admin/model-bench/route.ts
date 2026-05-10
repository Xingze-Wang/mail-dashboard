import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/model-bench
 *
 * Computes the leaderboard view for the bench page. For each prompt,
 * joins predictions with ground truth and reports calibration / AUC /
 * agreement-with-admin depending on kind.
 *
 * Ground-truth join is at READ time (not stored on the prediction
 * row) so we can recompute as outcomes arrive — a rep who applies
 * three weeks after the prediction shouldn't require a backfill.
 */
type LeaderboardRow = {
  prompt_id: string;
  kind: string;
  name: string;
  llm_model: string;
  persona_archetype: string | null;
  created_at: string;
  predictions: number;
  // Calibration: mean |predicted - actual| over predictions where
  // ground truth is available. Lower = better.
  mae: number | null;
  // For Model 2: agreement rate with admin's actual approval state.
  approval_agreement: number | null;
  // For Models 1, 3: actual click rate at this prompt's predicted-bucket
  // mid (0.0-0.2, 0.2-0.4, ..., 0.8-1.0) — calibration buckets.
  buckets: Array<{ range: string; predicted_n: number; actual_click_rate: number }>;
};

export async function GET(req: NextRequest) {
  const r = await requireAdmin(req);
  if ("response" in r) return r.response;

  const { data: prompts } = await supabase
    .from("model_prompts")
    .select("id, kind, name, llm_model, persona_archetype, created_at")
    .order("created_at", { ascending: false });

  if (!prompts) return NextResponse.json({ rows: [] });

  const rows: LeaderboardRow[] = [];

  for (const p of prompts) {
    const { data: preds } = await supabase
      .from("model_predictions")
      .select("id, email_id, template_id, headline, prediction")
      .eq("prompt_id", p.id);

    if (!preds || preds.length === 0) {
      rows.push({
        prompt_id: p.id, kind: p.kind, name: p.name, llm_model: p.llm_model,
        persona_archetype: p.persona_archetype, created_at: p.created_at,
        predictions: 0, mae: null, approval_agreement: null, buckets: [],
      });
      continue;
    }

    if (p.kind === "email_quality_judge") {
      const tmplIds = preds.map((x) => x.template_id).filter((x): x is string => !!x);
      const { data: tmpls } = await supabase
        .from("email_templates")
        .select("id, status, rejection_reason")
        .in("id", tmplIds);
      const tmplStatus = new Map((tmpls ?? []).map((t) => [t.id as string, t.status as string]));

      let agree = 0, total = 0;
      for (const pred of preds) {
        if (!pred.template_id) continue;
        const status = tmplStatus.get(pred.template_id);
        // Migration 066 added 'approved_draft' as an intermediate
        // approve-but-not-yet-active state. Both 'active' and
        // 'approved_draft' count as ground-truth-approved by admin.
        const adminApproved = (status === "active" || status === "approved_draft") ? 1 : 0;
        const rejected = status === "archived" ? 1 : 0;
        if (adminApproved === 0 && rejected === 0) continue; // pending — no GT yet
        const aiApproved = (pred.headline ?? 0) >= 0.5 ? 1 : 0;
        if (aiApproved === adminApproved) agree++;
        total++;
      }
      rows.push({
        prompt_id: p.id, kind: p.kind, name: p.name, llm_model: p.llm_model,
        persona_archetype: p.persona_archetype, created_at: p.created_at,
        predictions: preds.length,
        mae: null,
        approval_agreement: total > 0 ? agree / total : null,
        buckets: [],
      });
    } else {
      // persona_recipient or ctr_regressor — both use email_id and headline=p_click
      const emailIds = preds.map((x) => x.email_id).filter((x): x is string => !!x);
      const { data: emails } = await supabase
        .from("emails")
        .select("id, status")
        .in("id", emailIds);
      const emailStatus = new Map((emails ?? []).map((e) => [e.id as string, e.status as string]));

      let mae = 0, n = 0;
      const bucketCounts: Array<{ range: string; n: number; clicks: number }> = [
        { range: "0.0-0.2", n: 0, clicks: 0 },
        { range: "0.2-0.4", n: 0, clicks: 0 },
        { range: "0.4-0.6", n: 0, clicks: 0 },
        { range: "0.6-0.8", n: 0, clicks: 0 },
        { range: "0.8-1.0", n: 0, clicks: 0 },
      ];
      for (const pred of preds) {
        if (!pred.email_id) continue;
        const status = emailStatus.get(pred.email_id);
        if (!status) continue;
        const clicked = status === "clicked" ? 1 : 0;
        const predicted = pred.headline ?? 0;
        mae += Math.abs(predicted - clicked);
        n++;
        const bIdx = Math.min(4, Math.floor(predicted * 5));
        bucketCounts[bIdx].n++;
        if (clicked) bucketCounts[bIdx].clicks++;
      }
      rows.push({
        prompt_id: p.id, kind: p.kind, name: p.name, llm_model: p.llm_model,
        persona_archetype: p.persona_archetype, created_at: p.created_at,
        predictions: preds.length,
        mae: n > 0 ? mae / n : null,
        approval_agreement: null,
        buckets: bucketCounts.map((b) => ({
          range: b.range,
          predicted_n: b.n,
          actual_click_rate: b.n > 0 ? b.clicks / b.n : 0,
        })),
      });
    }
  }

  return NextResponse.json({ rows });
}
