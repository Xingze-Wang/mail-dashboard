import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { resend } from "@/lib/resend";
import { generateThreadId } from "@/lib/utils";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { from, to, subject, html, text, templateId } = body;

    if (!to || !subject) {
      return NextResponse.json({ error: "Missing required fields: to, subject" }, { status: 400 });
    }

    const senderEmail = from || `${process.env.SENDER_NAME} <${process.env.SENDER_EMAIL}>`;
    let emailHtml = html || "";
    let emailText = text;

    // If templateId provided, load template
    if (templateId) {
      const template = await prisma.template.findUnique({ where: { id: templateId } });
      if (!template) {
        return NextResponse.json({ error: "Template not found" }, { status: 404 });
      }
      emailHtml = template.html;
      emailText = template.text || undefined;
    }

    // Send via Resend
    const result = await resend.emails.send({
      from: senderEmail,
      to: Array.isArray(to) ? to : [to],
      subject,
      html: emailHtml,
      text: emailText || undefined,
    });

    if (result.error) {
      return NextResponse.json({ error: result.error.message }, { status: 500 });
    }

    // Store in DB
    const email = await prisma.email.create({
      data: {
        from: senderEmail,
        to: Array.isArray(to) ? to.join(", ") : to,
        subject,
        html: emailHtml,
        text: emailText || null,
        resendId: result.data?.id || null,
        status: "sent",
        threadId: generateThreadId(),
      },
    });

    return NextResponse.json({ id: email.id, resendId: result.data?.id });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to send email";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
