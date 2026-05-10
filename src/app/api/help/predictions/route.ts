import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { requireSession } from "@/lib/auth-helpers";
import { recordPrediction, type TargetEvent } from "@/lib/predictions";

export const dynamic = "force-dynamic";

const ALLOWED_EVENTS: TargetEvent[] = ["no_reply", "no_wechat", "reply", "wechat"];
const MAX_HORIZON_DAYS = 30;

/**
 * Derive a stable idempotency key from the request shape so a fast
 * double-tap (or 10 concurrent identical POSTs — see
 * SMOKE_TEST_REPORT_2026-05-09 finding #21) collapses to one
 * helper_predictions row. The hash is rep+claim+event+lead so the
 * same rep submitting genuinely-different claims still gets distinct
 * rows. Truncated to 32 hex chars; collisions within a single rep's
 * lifetime are vanishingly improbable. A client-supplied
 * Idempotency-Key (or body.requestId) overrides this — that's the
 * preferred path; this is the fallback.
 */
function deriveRequestId(parts: {
  repId: number;
  claim: string;
  targetEvent: string;
  targetLeadId: string | null;
  targetRecipient: string | null;
}): string {
  const seed = [
    parts.repId,
    parts.claim.trim(),
    parts.targetEvent,
    parts.targetLeadId ?? "",
    parts.targetRecipient ?? "",
  ].join("");
  return createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

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

  // Idempotency: prefer a client-supplied Idempotency-Key header (or
  // body.requestId). If neither, derive one from the request shape so
  // a fast double-tap still dedups. Migration 072 enforces uniqueness
  // at the DB layer; this just produces the key.
  const headerKey = req.headers.get("idempotency-key") || req.headers.get("x-idempotency-key");
  const bodyKey = typeof body.requestId === "string" && body.requestId.trim().length > 0
    ? body.requestId.trim().slice(0, 128)
    : null;
  const requestId = headerKey?.trim().slice(0, 128) || bodyKey || deriveRequestId({
    repId: session.repId,
    claim,
    targetEvent,
    targetLeadId: typeof body.targetLeadId === "string" ? body.targetLeadId : null,
    targetRecipient: typeof body.targetRecipient === "string" ? body.targetRecipient : null,
  });

  const row = await recordPrediction({
    repId: session.repId,
    conversationId: body.conversationId ?? null,
    messageId: body.messageId ?? null,
    claim,
    targetEvent: targetEvent as TargetEvent,
    targetLeadId: body.targetLeadId ?? null,
    targetRecipient: body.targetRecipient ?? null,
    targetDeadline,
    requestId,
  });
  if (!row) return NextResponse.json({ error: "insert failed" }, { status: 500 });
  return NextResponse.json({ prediction: row });
}
