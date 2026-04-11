import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { resend } from "@/lib/resend";
import { recordContact } from "@/lib/scanner";
import { getRep } from "@/lib/assignment";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { id } = body;

    if (!id) {
      return NextResponse.json({ error: "Missing required field: id" }, { status: 400 });
    }

    // Fetch the lead
    const { data: lead } = await supabase
      .from("pipeline_leads")
      .select("*")
      .eq("id", id)
      .single();

    if (!lead) {
      return NextResponse.json({ error: "Lead not found" }, { status: 404 });
    }

    if (lead.status !== "ready") {
      return NextResponse.json(
        { error: `Lead status is '${lead.status}', must be 'ready' to send` },
        { status: 400 },
      );
    }

    // Age gate: paper must be at least 1 day old
    if (lead.published_at) {
      const publishedDate = new Date(lead.published_at);
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

      if (publishedDate > oneDayAgo) {
        const availableAt = new Date(publishedDate.getTime() + 24 * 60 * 60 * 1000);
        return NextResponse.json(
          { error: "Paper must be at least 1 day old", availableAt: availableAt.toISOString() },
          { status: 400 },
        );
      }
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

    // Update pipeline lead status
    await supabase
      .from("pipeline_leads")
      .update({ status: "sent", sent_at: new Date().toISOString() })
      .eq("id", id);

    // Record in contact history (1-year dedup)
    await recordContact(lead.author_email, lead.title, lead.draft_subject);

    return NextResponse.json({ success: true, emailId: email.id });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to send email";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
