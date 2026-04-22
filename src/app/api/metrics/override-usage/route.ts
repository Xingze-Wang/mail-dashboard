import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import {
  buildQuotaCheck,
  countOverridesTodayByRep,
  DAILY_OVERRIDE_CAP,
} from "@/lib/override-quota";

export const dynamic = "force-dynamic";

/**
 * GET /api/metrics/override-usage
 * Returns the current rep's 7-day-override usage for today (Beijing).
 * Powers the "Override 7-day rule (3 / 200 used today)" label in
 * ReviewPane. Returns cap=0 when the caller has no rep session — the
 * client can treat "no cap" as "don't display a counter."
 */
export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session?.repId) {
    return NextResponse.json({
      used: 0,
      cap: 0,
      remaining: 0,
      hasQuota: false,
    });
  }
  const used = (await countOverridesTodayByRep(session.repId)) ?? 0;
  const quota = buildQuotaCheck(used);
  return NextResponse.json({
    used: quota.used,
    cap: DAILY_OVERRIDE_CAP,
    remaining: quota.remaining,
    hasQuota: true,
  });
}
