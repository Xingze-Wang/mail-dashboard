import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { diagnoseMetricDrop } from "@/lib/diagnose-metric";
import { computeSegmentFunnels } from "@/lib/segment-funnels";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/analysis/insights?repId=&days=7
 *
 * Powers the redesigned /analysis page hero. Three question-shaped
 * answers in one round-trip:
 *   - WINNING: best segment by post-click conversion (≥ 5 delivered).
 *   - LOSING: worst segment by CTR with non-trivial volume.
 *   - WHAT CHANGED: diagnose_metric_drop on click_rate for the window.
 *
 * Every answer carries enough context (numbers + segment name) for
 * the page to render an action button + a one-sentence summary.
 *
 * Scoping mirrors /api/analysis/segments — sales hard-scoped, admin
 * org-wide by default + ?repId override.
 */
export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const isAdmin = session.role === "admin";
  const queryRepId = url.searchParams.get("repId");
  const daysParam = url.searchParams.get("days");

  let repId: number | null = null;
  if (isAdmin && queryRepId && queryRepId !== "all") {
    const parsed = Number(queryRepId);
    repId = Number.isFinite(parsed) ? parsed : null;
  } else if (!isAdmin) {
    repId = session.repId;
  }
  let lookbackDays: number | null = null;
  if (daysParam && daysParam !== "all") {
    const parsed = Number(daysParam);
    if (Number.isFinite(parsed) && parsed > 0) lookbackDays = parsed;
  }

  // Pull funnels + metric-drop diagnosis in parallel. Both are read-only
  // and independent — saves ~half a second on a slow Supabase day.
  const days = lookbackDays ?? 7;
  const [funnels, ctrDrop, wechatDrop] = await Promise.all([
    computeSegmentFunnels({ repId, lookbackDays }),
    diagnoseMetricDrop({ metric: "click_rate", repId, days }),
    diagnoseMetricDrop({ metric: "wechat_rate", repId, days }),
  ]);

  // ── Find best winning segment: highest postClickConv with ≥ 5 delivered ──
  type Candidate = { segment: string; dimension: string; ctr: number; postClickConv: number; delivered: number };
  const all: Candidate[] = [];
  for (const dim of funnels.dimensions) {
    for (const seg of dim.segments) {
      if (seg.delivered < 5) continue;
      all.push({
        segment: seg.segment,
        dimension: dim.label,
        ctr: seg.ctr,
        postClickConv: seg.postClickConv,
        delivered: seg.delivered,
      });
    }
  }
  const winning = all.length > 0
    ? all.slice().sort((a, b) => b.postClickConv - a.postClickConv)[0]
    : null;

  // Losing: lowest CTR among segments with ≥ 10 delivered (need volume
  // before we recommend deprioritizing).
  const losingPool = all.filter((c) => c.delivered >= 10);
  const losing = losingPool.length > 0
    ? losingPool.slice().sort((a, b) => a.ctr - b.ctr)[0]
    : null;

  // What-changed picks the bigger story (CTR or wechat) by absolute
  // ratioChange. Tie goes to CTR (higher up the funnel = more
  // actionable).
  const ctrMag = "ratioChange" in ctrDrop ? Math.abs(ctrDrop.ratioChange) : 0;
  const wechatMag = "ratioChange" in wechatDrop ? Math.abs(wechatDrop.ratioChange) : 0;
  const headlineDrop = ctrMag >= wechatMag ? ctrDrop : wechatDrop;

  return NextResponse.json({
    scope: { repId, lookbackDays: days, isAdmin },
    totals: funnels.totals,
    winning,
    losing,
    headlineDrop,
  });
}
