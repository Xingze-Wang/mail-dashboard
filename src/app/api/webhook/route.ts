import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { resend } from "@/lib/resend";
import crypto from "crypto";

const STATUS_MAP: Record<string, string> = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.delivery_delayed": "sent",
  "email.opened": "opened",
  "email.clicked": "clicked",
  "email.bounced": "bounced",
  "email.complained": "complained",
};

function verifySignature(payload: string, signature: string | null, secret: string): boolean {
  if (!signature || !secret) return !secret; // skip verification if no secret configured
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();

    // Verify webhook signature if secret is configured
    const secret = process.env.RESEND_WEBHOOK_SECRET;
    if (secret) {
      const signature = req.headers.get("svix-signature") || req.headers.get("webhook-signature");
      if (!verifySignature(rawBody, signature, secret)) {
        return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
      }
    }

    const body = JSON.parse(rawBody);
    const { type, data } = body;

    if (!type || !data) {
      return NextResponse.json({ error: "Invalid webhook payload" }, { status: 400 });
    }

    // Only process email events
    if (!type.startsWith("email.")) {
      return NextResponse.json({ received: true, skipped: true });
    }

    const resendEmailId = data.email_id;
    let emailId: string | null = null;

    if (resendEmailId) {
      const { data: email } = await supabase
        .from("emails")
        .select("id")
        .eq("resend_id", resendEmailId)
        .single();

      if (email) {
        emailId = email.id;
      } else {
        // Email not in DB — fetch from Resend and create it
        const fetched = await resend.emails.get(resendEmailId);
        if (fetched.data) {
          const e = fetched.data;
          const threadId = `thread_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
          const status = STATUS_MAP[type] || "sent";

          const { data: inserted } = await supabase
            .from("emails")
            .insert({
              from: e.from,
              to: Array.isArray(e.to) ? e.to.join(", ") : (e.to || ""),
              subject: e.subject || "(no subject)",
              html: e.html || "",
              text: e.text || null,
              resend_id: e.id,
              status,
              created_at: e.created_at,
              updated_at: new Date().toISOString(),
              thread_id: threadId,
            })
            .select("id")
            .single();

          emailId = inserted?.id || null;
        }
      }
    }

    // Store the webhook event
    await supabase.from("webhook_events").insert({
      email_id: emailId,
      type,
      payload: rawBody,
    });

    // Update email status
    if (emailId) {
      const newStatus = STATUS_MAP[type];
      if (newStatus) {
        await supabase
          .from("emails")
          .update({ status: newStatus, updated_at: new Date().toISOString() })
          .eq("id", emailId);
      }
    }

    return NextResponse.json({ received: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Webhook processing failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
