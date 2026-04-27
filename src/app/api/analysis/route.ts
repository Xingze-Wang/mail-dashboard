import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { runAnalysis } from "@/lib/analysis";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/analysis?repId=<id>&days=<n>
 *
 * Returns adaptive rate breakdowns across every dimension we have signal
 * on. Self-evolving: low-coverage dimensions and low-N buckets are tagged
 * so the UI can hide them.
 *
 * Scoping:
 *   - admin can pass ?repId=<n> to see one rep's view, or omit for org-wide
 *   - sales is hard-scoped to their own repId regardless of query param
 *   - ?days=30 narrows the window (omit for all-time)
 */
export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
    // Hard-scoped to own data.
    repId = session.repId;
  }

  let lookbackDays: number | null = null;
  if (daysParam) {
    const parsed = Number(daysParam);
    if (Number.isFinite(parsed) && parsed > 0) lookbackDays = parsed;
  }

  const result = await runAnalysis({ repId, lookbackDays });

  return NextResponse.json({
    ...result,
    scopeMeta: {
      isAdmin,
      effectiveRepId: repId,
      lookbackDays,
    },
  });
}
