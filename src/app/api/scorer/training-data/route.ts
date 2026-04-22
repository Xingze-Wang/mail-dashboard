import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/scorer/training-data
 *
 * Surfaces the multi-source signal counts that feed the next training
 * run, so admin can see where the labels come from and spot blind spots
 * (e.g. lots of bad_compute corrections but scorer never retrained).
 *
 * Returns:
 *   - corrections: per-type counts + recent samples
 *   - signals: WeChat conversions, click signals, total leads, sent emails
 *   - history: last 8 scorer_runs (F1/AUC trend)
 *   - lastRunAt + nextScheduledAt
 */
export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  // Per-type correction counts. lead_corrections may not exist on dev — soft-fail.
  let perType: { type: string; count: number; lastAt: string | null }[] = [];
  let recentCorrections: { type: string; reason: string | null; corrected_by: string; corrected_at: string; lead_id: string }[] = [];
  try {
    const { data: rows } = await supabase
      .from("lead_corrections")
      .select("type, reason, corrected_by, corrected_at, lead_id")
      .order("corrected_at", { ascending: false })
      .limit(500);
    const arr = rows ?? [];
    const byType = new Map<string, { count: number; lastAt: string | null }>();
    for (const r of arr) {
      const t = r.type as string;
      const e = byType.get(t) ?? { count: 0, lastAt: null };
      e.count++;
      const when = r.corrected_at as string;
      if (!e.lastAt || when > e.lastAt) e.lastAt = when;
      byType.set(t, e);
    }
    perType = Array.from(byType.entries())
      .map(([type, v]) => ({ type, count: v.count, lastAt: v.lastAt }))
      .sort((a, b) => b.count - a.count);
    recentCorrections = arr.slice(0, 10).map((r) => ({
      type: r.type as string,
      reason: r.reason as string | null,
      corrected_by: r.corrected_by as string,
      corrected_at: r.corrected_at as string,
      lead_id: r.lead_id as string,
    }));
  } catch {
    // table missing — leave empty
  }

  // Signal counts
  const [
    { count: wechatCount },
    { count: clickedCount },
    { count: bouncedCount },
    { count: sentCount },
  ] = await Promise.all([
    supabase.from("brief_lookups").select("*", { count: "exact", head: true }).eq("added_wechat", true),
    supabase.from("emails").select("*", { count: "exact", head: true }).eq("status", "clicked"),
    supabase.from("emails").select("*", { count: "exact", head: true }).eq("status", "bounced"),
    supabase.from("emails").select("*", { count: "exact", head: true }).in("status", ["delivered", "clicked", "sent", "replied"]),
  ]);

  // Last 8 runs
  const { data: runsRaw } = await supabase
    .from("scorer_runs")
    .select("id, trained_at, cv_f1, cv_auc, cv_precision, cv_recall, n_samples, n_positive, n_negative")
    .order("trained_at", { ascending: false })
    .limit(8);

  const history = (runsRaw ?? []).map((r) => ({
    id: r.id,
    trainedAt: r.trained_at,
    f1: r.cv_f1,
    auc: r.cv_auc,
    precision: r.cv_precision,
    recall: r.cv_recall,
    nSamples: r.n_samples,
    nPositive: r.n_positive,
    nNegative: r.n_negative,
  }));

  // Compute deltas vs prior run for the dashboard sparkline
  for (let i = 0; i < history.length - 1; i++) {
    (history[i] as Record<string, unknown>).f1Delta = history[i].f1 - history[i + 1].f1;
    (history[i] as Record<string, unknown>).aucDelta = history[i].auc - history[i + 1].auc;
  }

  return NextResponse.json({
    corrections: {
      perType,
      total: perType.reduce((s, t) => s + t.count, 0),
      recent: recentCorrections,
    },
    signals: {
      wechatConversions: wechatCount ?? 0,
      emailClicks: clickedCount ?? 0,
      emailBounces: bouncedCount ?? 0,
      emailsSent: sentCount ?? 0,
    },
    history,
    lastRunAt: history[0]?.trainedAt ?? null,
    // Next Monday at 14:00 UTC.
    nextScheduledAt: nextMondayUTC(14).toISOString(),
  });
}

function nextMondayUTC(hour: number): Date {
  const now = new Date();
  const dayOfWeek = now.getUTCDay(); // 0=Sun, 1=Mon
  let daysUntil = (1 - dayOfWeek + 7) % 7;
  const next = new Date(now);
  next.setUTCHours(hour, 0, 0, 0);
  if (daysUntil === 0 && next < now) daysUntil = 7;
  next.setUTCDate(next.getUTCDate() + daysUntil);
  return next;
}
