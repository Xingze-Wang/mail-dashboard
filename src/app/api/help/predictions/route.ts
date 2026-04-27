import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { recordPrediction, type TargetEvent } from "@/lib/predictions";

export const dynamic = "force-dynamic";

const ALLOWED_EVENTS: TargetEvent[] = ["no_reply", "no_wechat", "reply", "wechat"];
const MAX_HORIZON_DAYS = 30;

/**
 * POST /api/help/predictions
 *
 * Rep clicks "track this" on a helper bubble that contains a
 * falsifiable claim. We capture the claim + the falsification
 * criterion. The cron resolver fires past target_deadline and writes
 * a self_critique to helper_learnings on misses.
 *
 * Body shape:
 *   {
 *     claim: string,
 *     targetEvent: "no_reply" | "no_wechat" | "reply" | "wechat",
 *     targetLeadId?: string,
 *     targetRecipient?: string,
 *     horizonDays?: number (default 7, capped at 30),
 *     conversationId?: string,
 *     messageId?: string
 *   }
 */
export async function POST(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const claim = String(body.claim ?? "").trim();
  const targetEvent = String(body.targetEvent ?? "");
  const horizonDays = Math.max(1, Math.min(MAX_HORIZON_DAYS, Number(body.horizonDays) || 7));

  if (claim.length < 5 || claim.length > 500) {
    return NextResponse.json({ error: "claim must be 5-500 chars" }, { status: 400 });
  }
  if (!ALLOWED_EVENTS.includes(targetEvent as TargetEvent)) {
    return NextResponse.json({ error: `targetEvent must be one of ${ALLOWED_EVENTS.join("|")}` }, { status: 400 });
  }

  const targetDeadline = new Date(Date.now() + horizonDays * 86_400_000);
  const row = await recordPrediction({
    repId: session.repId,
    conversationId: body.conversationId ?? null,
    messageId: body.messageId ?? null,
    claim,
    targetEvent: targetEvent as TargetEvent,
    targetLeadId: body.targetLeadId ?? null,
    targetRecipient: body.targetRecipient ?? null,
    targetDeadline,
  });
  if (!row) return NextResponse.json({ error: "insert failed" }, { status: 500 });
  return NextResponse.json({ prediction: row });
}
