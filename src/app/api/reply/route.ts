import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { resend } from "@/lib/resend";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { inboundEmailId, html, text } = body;

    if (!inboundEmailId || (!html && !text)) {
      return NextResponse.json({ error: "Missing inboundEmailId and content" }, { status: 400 });
    }

    // Find the inbound email we're replying to
    const inbound = await prisma.inboundEmail.findUnique({
      where: { id: inboundEmailId },
    });

    if (!inbound) {
      return NextResponse.json({ error: "Inbound email not found" }, { status: 404 });
    }

    // Build threading headers
    const replySubject = inbound.subject.startsWith("Re:") ? inbound.subject : `Re: ${inbound.subject}`;
    const references = inbound.references
      ? `${inbound.references} ${inbound.messageId || ""}`
      : inbound.messageId || "";

    const senderEmail = `${process.env.SENDER_NAME} <${process.env.SENDER_EMAIL}>`;

    // Send via Resend with threading headers
    const result = await resend.emails.send({
      from: senderEmail,
      to: [inbound.from],
      subject: replySubject,
      html: html || undefined,
      text: text || undefined,
      headers: {
        "In-Reply-To": inbound.messageId || "",
        References: references.trim(),
      },
    });

    if (result.error) {
      return NextResponse.json({ error: result.error.message }, { status: 500 });
    }

    // Store sent reply in DB
    const email = await prisma.email.create({
      data: {
        from: senderEmail,
        to: inbound.from,
        subject: replySubject,
        html: html || "",
        text: text || null,
        resendId: result.data?.id || null,
        status: "sent",
        inReplyTo: inbound.messageId,
        references: references.trim(),
        threadId: inbound.threadId,
      },
    });

    return NextResponse.json({ id: email.id, resendId: result.data?.id });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to send reply";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
