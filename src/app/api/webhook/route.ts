import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    // Resend webhook payload
    const { type, data } = body;

    if (!type || !data) {
      return NextResponse.json({ error: "Invalid webhook payload" }, { status: 400 });
    }

    // Find the email by resend ID
    const email = data.email_id
      ? await prisma.email.findFirst({ where: { resendId: data.email_id } })
      : null;

    // Store the webhook event
    await prisma.webhookEvent.create({
      data: {
        emailId: email?.id || null,
        type,
        payload: JSON.stringify(body),
      },
    });

    // Update email status based on event type
    if (email) {
      const statusMap: Record<string, string> = {
        "email.sent": "sent",
        "email.delivered": "delivered",
        "email.delivery_delayed": "sent",
        "email.opened": "opened",
        "email.clicked": "clicked",
        "email.bounced": "bounced",
        "email.complained": "complained",
      };

      const newStatus = statusMap[type];
      if (newStatus) {
        await prisma.email.update({
          where: { id: email.id },
          data: { status: newStatus },
        });
      }
    }

    return NextResponse.json({ received: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Webhook processing failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
