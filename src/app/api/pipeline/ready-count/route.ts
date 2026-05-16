import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { countReadyQueue } from "@/lib/canonical-counts";

/**
 * GET /api/pipeline/ready-count
 *
 * Returns counts of pipeline_leads with status='ready', scoped per rep
 * for non-admin sessions. Splits the count so every surface can choose
 * the same number:
 *
 *   count      — all ready leads (incl. ripening <7d). Kept for
 *                back-compat with existing sidebar/badge callers.
 *   readyNow   — ready AND past the 7-day cool-down (sendable without
 *                override).
 *   ripening   — ready AND still inside the 7-day window (need override
 *                to send today, will become readyNow once they age out).
 *
 * Prior behavior: ready-count returned only `count` (total ready). The
 * pipeline page derived "ready minus ripening" client-side, so its
 * counter didn't match the sidebar's. Now both numbers are served, so
 * every surface that wants "sendable now" can consume `readyNow` and
 * every surface that wants "in the funnel" can consume `count`.
 */
export async function GET(req: NextRequest) {
  // Fail-closed. Unauthenticated callers used to get the global count.
  const session = await requireSession(req);
  if (!session) {
    return NextResponse.json({ count: 0, readyNow: 0, ripening: 0 });
  }
  const isPrivileged = session.role === "admin";
  const { sendable, ripening, total } = await countReadyQueue(
    isPrivileged ? {} : { repId: session.repId },
  );
  return NextResponse.json({ count: total, readyNow: sendable, ripening });
}
