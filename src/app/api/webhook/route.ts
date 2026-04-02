import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { type, data } = body;

    if (!type || !data) {
      return NextResponse.json({ error: "Invalid webhook payload" }, { status: 400 });
    }

    // Find the email by resend ID
    let emailId: string | null = null;
    if (data.email_id) {
      const { data: email } = await supabase
        .from("emails")
        .select("id")
        .eq("resend_id", data.email_id)
        .single();
      emailId = email?.id || null;
    }

    // Store the webhook event
    await supabase.from("webhook_events").insert({
      email_id: emailId,
      type,
      payload: JSON.stringify(body),
    });

    // Update email status
    if (emailId) {
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
