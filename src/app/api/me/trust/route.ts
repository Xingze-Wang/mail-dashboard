import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { getCapabilities } from "@/lib/trust-level";

/**
 * GET /api/me/trust
 *
 * Returns the current rep's training-wheels state:
 *   { tier, canBulkSend, bulkBatchMax, dailyLeadCap, dailySendCap,
 *     totalSends, trustLevel, tenureDays, reason }
 *
 * Used by /pipeline to render hints ("3 more sends until bulk unlocks")
 * and by the BulkPane to gray out the bulk action when not allowed.
 *
 * Auth: standard session cookie. Returns 401 if no session.
 */
export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const caps = await getCapabilities(session.repId);
  return NextResponse.json(caps);
}
