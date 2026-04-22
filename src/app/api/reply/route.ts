import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { resend } from "@/lib/resend";
import { requireSession } from "@/lib/auth-helpers";
import { getRep } from "@/lib/assignment";

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

    const replySubject = (inbound.subject.startsWith("Re:") || inbound.subject.startsWith("回复"))
      ? inbound.subject
      : `Re: ${inbound.subject}`;
    const references = inbound.references
      ? `${inbound.references} ${inbound.message_id || ""}`
      : inbound.message_id || "";

    // Per-sales sender identity: a reply must come from the SAME address
    // the author is already conversing with, not a shared "no-reply" box.
    // Resolution order (first hit wins):
    //   1. The thread's original outbound row — canonical, matches what
    //      the recipient saw in their inbox.
    //   2. The logged-in rep's sales_reps entry — when the outbound row
    //      is missing (shouldn't happen in practice).
    //   3. The env SENDER_* — last-resort so the reply still goes out.
    let senderEmail = `${process.env.SENDER_NAME} <${process.env.SENDER_EMAIL}>`;
    if (inbound.thread_id) {
      const { data: outbound } = await supabase
        .from("emails")
        .select("from")
        .eq("thread_id", inbound.thread_id)
        .eq("status", "sent")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (outbound?.from) {
        senderEmail = outbound.from as string;
      }
    }
    // If we still don't have a thread-pinned sender (new reply path),
    // fall back to whoever is logged in.
    if (senderEmail.startsWith(`${process.env.SENDER_NAME ?? ""} <`)) {
      const session = await requireSession(req);
      if (session?.repId) {
        const rep = await getRep(session.repId);
        if (rep) {
          senderEmail = `${rep.sender_name} <${rep.sender_email}>`;
        }
      }
    }

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
