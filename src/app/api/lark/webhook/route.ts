// Lark HTTP webhook — kept as a fallback transport. Primary is the
// long-connection WebSocket worker (scripts/lark-bot-worker.mjs) which
// avoids the public-URL + signature-verify + Vercel-deploy dance.
//
// All inbound-message logic lives in src/lib/lark-agent.ts so both
// transports are byte-identical. This handler is just the HTTP shim:
// signature verify → 200 ack inside Lark's 3s window via after().

import { NextRequest, NextResponse, after } from "next/server";
import { verifyLarkEvent } from "@/lib/lark";
import { processInboundLarkMessage } from "@/lib/lark-agent";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  const verify = verifyLarkEvent({
    rawBody,
    timestamp: req.headers.get("x-lark-request-timestamp"),
    nonce: req.headers.get("x-lark-request-nonce"),
    signature: req.headers.get("x-lark-signature"),
  });
  if (!verify.ok) {
    console.error("[lark/webhook] signature failed:", verify.reason);
    return NextResponse.json({ error: verify.reason }, { status: 401 });
  }

  let body: { type?: string; challenge?: string; encrypt?: string; event?: unknown; header?: { event_type?: string } };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  // URL verification challenge — Lark sends this once when you set the
  // webhook URL in the Open Platform console. Echo the challenge back.
  if (body.type === "url_verification" && body.challenge) {
    return NextResponse.json({ challenge: body.challenge });
  }

  if (body.encrypt) {
    console.error("[lark/webhook] encrypted body not supported (set encrypt_key off in app)");
    return NextResponse.json({ ok: false, reason: "encrypt not supported" }, { status: 200 });
  }

  const eventType = body.header?.event_type ?? body.type ?? "";
  if (!eventType.startsWith("im.message")) {
    return NextResponse.json({ ok: true, skipped: eventType }, { status: 200 });
  }
  if (!body.event) {
    return NextResponse.json({ ok: true, skipped: "no event" }, { status: 200 });
  }

  // ALL DB + LLM work moves into after() — returning 200 ASAP keeps us
  // inside Lark's 3s ack window.
  after(async () => {
    try {
      await processInboundLarkMessage(body, "webhook");
    } catch (err) {
      console.error("[lark/webhook] processInboundLarkMessage threw", err);
    }
  });

  return NextResponse.json({ ok: true }, { status: 200 });
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    route: "/api/lark/webhook",
    config: {
      app_id_set: !!process.env.LARK_APP_ID,
      app_secret_set: !!process.env.LARK_APP_SECRET,
      verification_token_set: !!process.env.LARK_VERIFICATION_TOKEN,
      region: process.env.LARK_REGION === "cn" ? "cn" : "global",
    },
  });
}
