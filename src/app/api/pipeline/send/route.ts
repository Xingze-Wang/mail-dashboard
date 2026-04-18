import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { resend } from "@/lib/resend";
import { recordContact } from "@/lib/scanner";
import { getRep } from "@/lib/assignment";
import { checkSendAllowed, SEND_MIN_AGE_DAYS, CONTACT_DEDUP_DAYS } from "@/lib/contact-guard";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { id } = body;

    if (!id) {
      return NextResponse.json({ error: "Missing required field: id" }, { status: 400 });
    }

    const { data: lead } = await supabase
      .from("pipeline_leads")
      .select("*")
      .eq("id", id)
      .single();

    if (!lead) {
      return NextResponse.json({ error: "Lead not found" }, { status: 404 });
    }

    const guard = await checkSendAllowed(lead);
    if (!guard.ok) {
      const messages: Record<string, string> = {
        bad_status: `Lead status is '${"status" in guard ? guard.status : ""}', must be 'ready'`,
        no_draft: "Lead has no draft",
        too_new: `Paper must be at least ${SEND_MIN_AGE_DAYS} days old`,
        already_contacted: `Recipient was contacted within the last ${CONTACT_DEDUP_DAYS} days`,
      };
      const httpStatus = guard.code === "bad_status" || guard.code === "no_draft" ? 400 : 409;
      return NextResponse.json(
        { ...guard, error: messages[guard.code] },
        { status: httpStatus },
      );
    }

    // Look up assigned rep (fall back to env vars)
    let senderFrom = `${process.env.SENDER_NAME} <${process.env.SENDER_EMAIL}>`;
    if (lead.assigned_rep_id) {
      const rep = await getRep(lead.assigned_rep_id);
      if (rep) {
        senderFrom = `${rep.sender_name} <${rep.sender_email}>`;
      }
    }

    const result = await resend.emails.send({
      from: senderFrom,
      to: [lead.author_email],
      bcc: ["williamxwang03@gmail.com"],
      subject: lead.draft_subject,
      html: lead.draft_html,
    });

    if (result.error) {
      return NextResponse.json({ error: result.error.message }, { status: 500 });
    }

    // Save to emails table
    const threadId = `thread_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    const { data: email, error: emailError } = await supabase
      .from("emails")
      .insert({
        from: senderFrom,
        to: lead.author_email,
        subject: lead.draft_subject,
        html: lead.draft_html,
        resend_id: result.data?.id || null,
        status: "sent",
        thread_id: threadId,
      })
      .select()
      .single();

    if (emailError) {
      return NextResponse.json({ error: emailError.message }, { status: 500 });
    }

    const { error: updateError } = await supabase
      .from("pipeline_leads")
      .update({ status: "sent", sent_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();

    if (updateError) {
      console.error("pipeline_leads update failed after send", { id, updateError });
    }

    // Contact history bookkeeping — fire-and-forget so the response doesn't
    // wait on the persons table upsert (which is the slow hop).
    recordContact(lead.author_email, lead.title, lead.draft_subject).catch((e) => {
      console.error("recordContact failed (non-blocking)", e);
    });

    return NextResponse.json({ success: true, emailId: email.id });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to send email";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
