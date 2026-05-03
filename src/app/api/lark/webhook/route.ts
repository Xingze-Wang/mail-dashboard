// Lark HTTP webhook.
//
// Cold-start optimized: the URL-verification path (which Lark hits to
// validate the webhook URL when you click Save in the Open Platform
// console) returns the challenge with ZERO heavy imports. Supabase,
// LLM proxy, agent code — none of it is loaded unless we have a real
// inbound message event.
//
// Why: Lark's URL verification has a 3s timeout. From iad1 (Vercel's
// default us-east) to feishu.cn the network alone is 200-300ms RTT;
// loading the full agent module on cold start adds 1-2s; signature
// verify adds 50ms. That's the 3s budget gone before we send the
// echo. Fast-path the challenge → cold-start hits 200-400ms.

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
// Pin to Hong Kong region so Lark traffic doesn't cross the Pacific.
export const preferredRegion = ["hkg1"];

export async function POST(req: Request) {
  const rawBody = await req.text();

  // FAST PATH: parse just enough to detect url_verification, return
  // immediately. No imports, no DB, no signature check — Lark's URL
  // verification is unsigned and the entire payload is plain JSON.
  let parsed: { type?: string; challenge?: string; encrypt?: string; event?: unknown; header?: { event_type?: string } };
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (parsed.type === "url_verification" && parsed.challenge) {
    return NextResponse.json({ challenge: parsed.challenge });
  }

  if (parsed.encrypt) {
    return NextResponse.json({ ok: false, reason: "encrypt not supported" }, { status: 200 });
  }

  // ALL OTHER PATHS: signature verify, then dispatch via after().
  // Imports are dynamic so they only load on real message events.
  const { verifyLarkEvent } = await import("@/lib/lark");
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

  const eventType = parsed.header?.event_type ?? parsed.type ?? "";
  const isMessage = eventType.startsWith("im.message");
  const isCardAction = eventType.startsWith("card.action.trigger");
  if (!isMessage && !isCardAction) {
    return NextResponse.json({ ok: true, skipped: eventType }, { status: 200 });
  }
  if (!parsed.event) {
    return NextResponse.json({ ok: true, skipped: "no event" }, { status: 200 });
  }

  // ALL DB + LLM work moves into after() — returning 200 ASAP keeps us
  // inside Lark's 3s ack window.
  const { after } = await import("next/server");
  after(async () => {
    try {
      const agent = await import("@/lib/lark-agent");
      if (isCardAction) {
        await agent.processJitrCardAction(parsed, "webhook");
      } else {
        await agent.processInboundLarkMessage(parsed, "webhook");
      }
    } catch (err) {
      console.error("[lark/webhook] handler threw", err);
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
      function_region: process.env.VERCEL_REGION || "(default)",
    },
  });
}
