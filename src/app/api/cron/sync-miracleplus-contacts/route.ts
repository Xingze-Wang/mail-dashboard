import { NextRequest, NextResponse } from "next/server";
import { syncRecentOutbound } from "@/lib/miracleplus-sync";

// 300s is the Pro-plan ceiling. Real-world we expect ~5-30s for a
// 7-day window at current outbound volume (~100-300 distinct
// recipients × 200ms gap = up to ~60s + per-call latency).
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * GET /api/cron/sync-miracleplus-contacts
 *
 * Auth: Bearer $CRON_SECRET.
 *
 * Pulls every recipient our reps actually emailed in the last 7 days
 * and re-syncs MP's contact state for each into `miracleplus_contacts`.
 *
 * Why 7 days of overlap (and not, say, 24h):
 *   1. Conversion happens AFTER outreach, often days later. If a
 *      person we emailed on day 0 finally submits on day 5, we want
 *      to catch it.
 *   2. MP contact state mutates server-side (someone progresses from
 *      "Submitted" → "Interview"). Re-syncing is how we see the new
 *      stage.
 *   3. The cost is bounded — at our current volume the 7-day distinct
 *      recipient count is in the low hundreds.
 *
 * Wired into vercel.json as a standalone cron at 05:00 UTC = 13:00
 * Beijing, AND into the master /api/cron fan-out so Hobby plan cron
 * cap isn't a problem.
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const ran_at = new Date().toISOString();

  try {
    const result = await syncRecentOutbound({ since });
    return NextResponse.json({
      ok: true,
      ran_at,
      since: since.toISOString(),
      ...result,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        ran_at,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
