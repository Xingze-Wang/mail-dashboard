import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { Webhook } from "svix";

export const dynamic = "force-dynamic";

/**
 * GET /api/webhook/health
 *
 * Diagnostic snapshot of the Resend webhook plumbing:
 *   - Whether RESEND_WEBHOOK_SECRET is configured (and looks like a whsec_)
 *   - webhook_events totals + most-recent timestamp per type
 *   - 24h-staleness flag (red if we sent emails today but heard nothing)
 *   - Expected Resend webhook URL so dashboard config can be eyeballed
 *
 * No auth — health probe, returns no PII.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  const secretConfigured = !!secret && secret.startsWith("whsec_");

  const { count, error } = await supabase
    .from("webhook_events")
    .select("*", { count: "exact", head: true });

  const { data: latestRows } = await supabase
    .from("webhook_events")
    .select("type, created_at")
    .order("created_at", { ascending: false })
    .limit(50);

  // Most-recent timestamp per type (kept tiny — first occurrence wins).
  const latestByType: Record<string, string> = {};
  for (const r of latestRows ?? []) {
    if (!latestByType[r.type]) latestByType[r.type] = r.created_at;
  }

  const mostRecent = latestRows?.[0]?.created_at ?? null;
  const dayAgoIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const hadEventInLast24h = !!mostRecent && mostRecent >= dayAgoIso;

  const { count: sentLast24h } = await supabase
    .from("emails")
    .select("*", { count: "exact", head: true })
    .gte("created_at", dayAgoIso);

  const stale24h = !hadEventInLast24h && (sentLast24h ?? 0) > 0;

  const expectedUrl = `${req.nextUrl.origin}/api/webhook`;

  let diagnosis: string;
  if ((count ?? 0) === 0) {
    diagnosis = secretConfigured
      ? "Secret is configured but no events have ever landed. Check Resend Dashboard → Webhooks → Endpoint URL matches expectedResendWebhookUrl, and that the signing secret in the dashboard matches RESEND_WEBHOOK_SECRET."
      : "Secret is NOT configured. Set RESEND_WEBHOOK_SECRET env var AND configure the webhook in Resend Dashboard.";
  } else if (stale24h) {
    diagnosis = `STALE: last webhook event was ${mostRecent}, but ${sentLast24h} emails were sent in the last 24h. Resend should have delivered something. Check signature/URL.`;
  } else {
    diagnosis = "Events are landing. Webhook is healthy.";
  }

  return NextResponse.json({
    secretConfigured,
    secretLength: secret?.length ?? 0,
    webhookEventsTable: {
      reachable: !error,
      error: error?.message ?? null,
      totalCount: count ?? 0,
      mostRecent,
      latestByType,
      sentLast24h: sentLast24h ?? 0,
      stale24h,
    },
    expectedResendWebhookUrl: expectedUrl,
    diagnosis,
  });
}

/**
 * POST /api/webhook/health
 *
 * Faithful signature-verification test using the same svix verifier the
 * real /api/webhook uses. Send the same headers Resend would send
 * (svix-id, svix-timestamp, svix-signature). Returns whether OUR
 * verifier accepts it. Useful when Resend says "we delivered" but
 * webhook_events stays empty.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.RESEND_WEBHOOK_SECRET || "";
  const rawBody = await req.text();
  const headers = {
    "svix-id": req.headers.get("svix-id") || req.headers.get("webhook-id") || "",
    "svix-timestamp": req.headers.get("svix-timestamp") || req.headers.get("webhook-timestamp") || "",
    "svix-signature": req.headers.get("svix-signature") || req.headers.get("webhook-signature") || "",
  };

  let verified = false;
  let errorMessage: string | null = null;
  if (secret) {
    try {
      new Webhook(secret).verify(rawBody, headers);
      verified = true;
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : "verification failed";
    }
  } else {
    errorMessage = "RESEND_WEBHOOK_SECRET not set";
  }

  return NextResponse.json({
    receivedBytes: rawBody.length,
    secretConfigured: !!secret,
    headersReceived: {
      "svix-id": headers["svix-id"] ? "present" : "missing",
      "svix-timestamp": headers["svix-timestamp"] || "missing",
      "svix-signature": headers["svix-signature"] ? `${headers["svix-signature"].slice(0, 20)}...` : "missing",
    },
    verified,
    error: errorMessage,
    note: "Mirrors /api/webhook verification. If verified=true here but webhook_events stays empty in prod, the bug is downstream of signature check.",
  });
}
