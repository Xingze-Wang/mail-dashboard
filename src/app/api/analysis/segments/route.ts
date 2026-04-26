import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { computeSegmentFunnels } from "@/lib/segment-funnels";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/analysis/segments?repId=<id>&days=<n>
 *
 * Two-stage funnel breakdown per segment. The shape every dimension
 * returns is { delivered, clicked, wechat, ctr, postClickConv,
 * endToEnd } — the two rates side-by-side answer "where does this
 * segment win or lose in the funnel?"
 *
 * Scope:
 *   - sales: hard-scoped to own sends (by sender_email match)
 *   - admin: org-wide by default; ?repId=<n> to inspect a rep
 */
export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const queryRepId = url.searchParams.get("repId");
  const daysParam = url.searchParams.get("days");
  const isAdmin = session.role === "admin";

  let repId: number | null = null;
  if (isAdmin) {
    if (queryRepId && queryRepId !== "all") {
      const parsed = Number(queryRepId);
      repId = Number.isFinite(parsed) ? parsed : null;
    }
  } else {
    repId = session.repId;
  }
  let lookbackDays: number | null = null;
  if (daysParam) {
    const parsed = Number(daysParam);
    if (Number.isFinite(parsed) && parsed > 0) lookbackDays = parsed;
  }

  const result = await computeSegmentFunnels({ repId, lookbackDays });
  return NextResponse.json({ ...result, scopeMeta: { isAdmin, effectiveRepId: repId, lookbackDays } });
}
