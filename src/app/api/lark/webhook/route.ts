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
  // Lark uses both "card.action.trigger" and the legacy "interactive_card"
  // event names depending on app version / event subscription mode.
  // Cover both — the symptom of getting this wrong is "card lands, click
  // does nothing", which is exactly what we hit.
  const isCardAction =
    eventType.startsWith("card.action.trigger") ||
    eventType === "interactive_card" ||
    eventType === "card.action";

  // Fire-and-forget capture into lark_webhook_trace. We do this BEFORE
  // the early-skip below so even unknown event_types get a row; that
  // way "Lark calls our webhook but we drop it" becomes visible. The
  // import is dynamic so the URL-verification fast path stays cold-
  // start light.
  {
    const ev = (parsed.event as {
      operator?: { open_id?: string };
      action?: { value?: Record<string, unknown> };
    } | undefined);
    const operator = ev?.operator?.open_id ?? null;
    const actionValue = ev?.action?.value ?? null;
    void import("@/lib/db").then(({ supabase }) =>
      supabase.from("lark_webhook_trace").insert({
        event_type: eventType,
        is_card_action: isCardAction,
        operator_open_id: operator,
        action_value: actionValue as object | null,
        header: parsed.header ?? null,
        event: parsed.event ?? null,
      }),
    ).catch((e) => console.error("[webhook-trace] insert failed:", e));
  }

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
        } else if ("admin_inbox_action" in value) {
          const card = await import("@/lib/admin-inbox-card");
          await card.processAdminInboxCardAction(parsed);
        } else if ("template_action" in value) {
          const card = await import("@/lib/admin-approval-cards");
          await card.processTemplateCardAction(parsed);
        } else if ("quota_action" in value) {
          const card = await import("@/lib/admin-approval-cards");
          await card.processQuotaCardAction(parsed);
        } else if ("congress_action" in value) {
          const card = await import("@/lib/admin-approval-cards");
          await card.processCongressCardAction(parsed);
        } else if ("jitr_action" in value) {
          await agent.processJitrCardAction(parsed, "webhook");
        } else {
          // No known discriminator. Loud log so a missing dispatcher
          // case doesn't fall into a silent-failure incident. Every
          // card the app emits must register a discriminator in this
          // switch AND in the worker (scripts/lark-bot-worker.ts).
          console.error(
            "[lark/webhook] unknown card action discriminator. value keys:",
            Object.keys(value).join(","),
            "— register a branch in BOTH webhook and worker.",
          );
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
    const oAction = (value.onboarding_action as string | undefined) ?? "";
    const aInbox = (value.admin_inbox_action as string | undefined) ?? "";
    const tplAction = (value.template_action as string | undefined) ?? "";
    const quotaAction = (value.quota_action as string | undefined) ?? "";
    const congressAction = (value.congress_action as string | undefined) ?? "";
    const jitrAction = (value.jitr_action as string | undefined) ?? "";
    let toastContent = "Received";
    if (oAction === "deny") toastContent = "Denied — sending notification…";
    else if (oAction === "approve_sales" || oAction === "approve_senior") toastContent = "Approved — provisioning + sending welcome email…";
    else if (aInbox === "yes") toastContent = "✅ 同意";
    else if (aInbox === "no") toastContent = "❌ 不做";
    else if (aInbox === "skill") toastContent = "🛠 存为 skill…";
    else if (aInbox === "memory") toastContent = "💾 存为 memory…";
    else if (aInbox === "both") toastContent = "⚡ 存为 skill + memory…";
    else if (aInbox === "neither") toastContent = "🗑 不留";
    else if (tplAction === "approve_draft") toastContent = "✓ Approved as draft";
    else if (tplAction === "activate") toastContent = "🚀 Activating template…";
    else if (tplAction === "reject") toastContent = "❌ Rejected — reply with reason";
    else if (quotaAction === "apply") toastContent = "✓ Applying quota…";
    else if (quotaAction === "dismiss") toastContent = "🗑 Dismissed";
    else if (congressAction === "accept") toastContent = "✓ Accepted proposal";
    else if (congressAction === "reject") toastContent = "❌ Rejected proposal";
    else if (jitrAction === "accept") toastContent = "✓ Accepted offer";
    else if (jitrAction === "dismiss") toastContent = "🗑 Dismissed";
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
