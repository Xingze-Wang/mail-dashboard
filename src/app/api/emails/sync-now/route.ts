import { NextRequest, NextResponse } from "next/server";
import { syncFromResend } from "@/lib/sync";
import { requireAdmin } from "@/lib/auth-helpers";

// One-shot full Resend → DB sync. Admin-only. Runs the same paginate-
// until-has_more-false drain that cron does, but with a longer budget
// so it can catch up after a long gap. Use when the admin overview
// looks stale or after a Resend webhook outage.
//
// POST /api/emails/sync-now
// returns { imported, updated, inboundImported, total, complete, errors }
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const result = await syncFromResend(280_000); // ~5 min, keep slack under maxDuration
  return NextResponse.json(result);
}
