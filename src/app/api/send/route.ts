import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { resend } from "@/lib/resend";
import { requireAdmin } from "@/lib/auth-helpers";

// Low-level send endpoint — bypasses all pipeline guards (age-gate,
// blocklist, contact-guard), so admin-only. Everyday sales sends must
// go through /api/pipeline/send.
export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  try {
    const body = await req.json();
    const { from, to, subject, html, text, templateId } = body;

    if (!to || !subject) {
      return NextResponse.json({ error: "Missing required fields: to, subject" }, { status: 400 });
    }

    const senderEmail = from || `${process.env.SENDER_NAME} <${process.env.SENDER_EMAIL}>`;
    let emailHtml = html || "";
    let emailText = text;

    if (templateId) {
      const { data: template } = await supabase
        .from("templates")
        .select()
        .eq("id", templateId)
        .single();
      if (!template) {
        return NextResponse.json({ error: "Template not found" }, { status: 404 });
      }
      emailHtml = template.html;
      emailText = template.text || undefined;
    }

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

    const threadId = `thread_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    const { data: email, error } = await supabase
      .from("emails")
      .insert({
        from: senderEmail,
        to: Array.isArray(to) ? to.join(", ") : to,
        subject,
        html: emailHtml,
        text: emailText || null,
        resend_id: result.data?.id || null,
        status: "sent",
        thread_id: threadId,
      })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ id: email.id, resendId: result.data?.id });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to send email";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
