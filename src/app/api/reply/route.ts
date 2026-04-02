import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { resend } from "@/lib/resend";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { inboundEmailId, html, text } = body;

    if (!inboundEmailId || (!html && !text)) {
      return NextResponse.json({ error: "Missing inboundEmailId and content" }, { status: 400 });
    }

    const { data: inbound } = await supabase
      .from("inbound_emails")
      .select()
      .eq("id", inboundEmailId)
      .single();

    if (!inbound) {
      return NextResponse.json({ error: "Inbound email not found" }, { status: 404 });
    }

    const replySubject = inbound.subject.startsWith("Re:") ? inbound.subject : `Re: ${inbound.subject}`;
    const references = inbound.references
      ? `${inbound.references} ${inbound.message_id || ""}`
      : inbound.message_id || "";

    const senderEmail = `${process.env.SENDER_NAME} <${process.env.SENDER_EMAIL}>`;

    const result = await resend.emails.send({
      from: senderEmail,
      to: [inbound.from],
      subject: replySubject,
      html: html || undefined,
      text: text || undefined,
      headers: {
        "In-Reply-To": inbound.message_id || "",
        References: references.trim(),
      },
    });

    if (result.error) {
      return NextResponse.json({ error: result.error.message }, { status: 500 });
    }

    const { data: email, error } = await supabase
      .from("emails")
      .insert({
        from: senderEmail,
        to: inbound.from,
        subject: replySubject,
        html: html || "",
        text: text || null,
        resend_id: result.data?.id || null,
        status: "sent",
        in_reply_to: inbound.message_id,
        references: references.trim(),
        thread_id: inbound.thread_id,
      })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ id: email.id, resendId: result.data?.id });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to send reply";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
