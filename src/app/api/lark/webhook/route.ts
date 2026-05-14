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

  // FAST PATH: parse just enough to detect url_verification + card-
  // action shape. We acknowledge BOTH ASAP — no imports, no DB, no
  // signature verify — because:
  //   - url_verification: Lark expects challenge echo in <3s
  //   - card.action.trigger: Lark expects toast response in <3s,
  //     and any cold-start work on the critical path was causing
  //     "target callback service timed out" (200340) toasts.
  // Signature verify still happens for both, but moves into after()
  // alongside the heavy work; processOnboardingCardAction does its
  // own auth check (senderIsAdmin) on the operator open_id so we
  // don't lose the security invariant.
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

  const eventType = parsed.header?.event_type ?? parsed.type ?? "";
  const isMessage = eventType.startsWith("im.message");
  const isCardAction = eventType.startsWith("card.action.trigger");
  if (!isMessage && !isCardAction) {
    return NextResponse.json({ ok: true, skipped: eventType }, { status: 200 });
  }
  if (!parsed.event) {
    return NextResponse.json({ ok: true, skipped: "no event" }, { status: 200 });
  }

  // Dispatch ALL work (including signature verify) into after() so the
  // synchronous response is as fast as possible — pure JSON serialize.
  const { after } = await import("next/server");
  after(async () => {
    try {
      const { verifyLarkEvent } = await import("@/lib/lark");
      const verify = verifyLarkEvent({
        rawBody,
        timestamp: req.headers.get("x-lark-request-timestamp"),
        nonce: req.headers.get("x-lark-request-nonce"),
        signature: req.headers.get("x-lark-signature"),
      });
      if (!verify.ok) {
        console.error("[lark/webhook] signature failed:", verify.reason);
        return;
      }
      const agent = await import("@/lib/lark-agent");
      if (isCardAction) {
        // Card-action discriminator: the inner event.action.value carries
        // the card type. Onboarding cards stamp `onboarding_action`,
        // JITR cards stamp `jitr_action`. Route accordingly.
        const ev = (parsed as { event?: { action?: { value?: Record<string, unknown> } } }).event;
        const value = ev?.action?.value ?? {};
        if ("onboarding_action" in value) {
          const onboarding = await import("@/lib/onboarding");
          await onboarding.processOnboardingCardAction(parsed);
        } else {
          await agent.processJitrCardAction(parsed, "webhook");
        }
      } else {
        await agent.processInboundLarkMessage(parsed, "webhook");
      }
    } catch (err) {
      console.error("[lark/webhook] handler threw", err);
    }
  });

  // Card-action callbacks need a Lark-shaped response, not {ok:true}:
  //   - {} caused 'code: 200345' (invalid payload).
  //   - delayed response causes 'code: 200340' (timeout / unreachable).
  // Per Lark interactive-card v2 docs, the immediate ack should be a
  // toast object: {toast: {type, content}}. Client renders the toast,
  // marks the click successful, and our after() does the heavy work
  // (provisioning, walkthrough) asynchronously.
  if (isCardAction) {
    const ev = (parsed as { event?: { action?: { value?: Record<string, unknown> } } }).event;
    const value = ev?.action?.value ?? {};
    const action = (value.onboarding_action as string | undefined) ?? "";
    const toastContent =
      action === "deny" ? "已拒绝, 正在发拒绝通知…" :
      action === "approve_sales" || action === "approve_senior" ? "已通过, 正在开账号 + 发欢迎邮件…" :
      "已收到";
    return NextResponse.json({
      toast: { type: "success", content: toastContent },
    }, { status: 200 });
  }
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
