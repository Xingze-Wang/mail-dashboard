import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    // Resend inbound webhook payload
    const { from, to, subject, html, text, message_id, in_reply_to, references, headers } = body;

    // Try to find a thread this belongs to
    let threadId: string | null = null;

    if (in_reply_to) {
      // Check if this is a reply to one of our sent emails
      const sentEmail = await prisma.email.findFirst({
        where: { messageId: in_reply_to },
      });
      if (sentEmail?.threadId) {
        threadId = sentEmail.threadId;
      }

      // Also check if it's a reply to another inbound email
      if (!threadId) {
        const prevInbound = await prisma.inboundEmail.findFirst({
          where: { messageId: in_reply_to },
        });
        if (prevInbound?.threadId) {
          threadId = prevInbound.threadId;
        }
      }
    }

    // If no thread found, create a new one
    if (!threadId) {
      threadId = `thread_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    }

    const inbound = await prisma.inboundEmail.create({
      data: {
        from: from || "unknown",
        to: Array.isArray(to) ? to.join(", ") : (to || ""),
        subject: subject || "(no subject)",
        html: html || null,
        text: text || null,
        messageId: message_id || null,
        inReplyTo: in_reply_to || null,
        references: references || null,
        threadId,
        headers: headers ? JSON.stringify(headers) : null,
      },
    });

    return NextResponse.json({ id: inbound.id, threadId });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to process inbound email";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// GET: list inbound emails
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "50");

  const [emails, total] = await Promise.all([
    prisma.inboundEmail.findMany({
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.inboundEmail.count(),
  ]);

  return NextResponse.json({ emails, total, page, limit });
}
