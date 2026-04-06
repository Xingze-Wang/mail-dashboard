import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { resend } from "@/lib/resend";
import { recordContact } from "@/lib/scanner";

/**
 * POST /api/pipeline/batch-send
 * Send multiple leads at once.
 * Body: { ids: string[] }
 */
export async function POST(req: NextRequest) {
  try {
    const { ids } = await req.json();

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ error: "Missing ids array" }, { status: 400 });
    }

    if (ids.length > 50) {
      return NextResponse.json({ error: "Max 50 at a time" }, { status: 400 });
    }

    const senderFrom = `${process.env.SENDER_NAME} <${process.env.SENDER_EMAIL}>`;
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    let sent = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const id of ids) {
      const { data: lead } = await supabase
        .from("pipeline_leads")
        .select("*")
        .eq("id", id)
        .single();

      if (!lead) {
        errors.push(`${id}: not found`);
        skipped++;
        continue;
      }

      if (lead.status !== "ready") {
        skipped++;
        continue;
      }

      if (!lead.draft_subject || !lead.draft_html) {
        errors.push(`${id}: no draft`);
        skipped++;
        continue;
      }

      // Age gate
      if (lead.published_at && new Date(lead.published_at) > oneDayAgo) {
        skipped++;
        continue;
      }

      // Send via Resend
      const result = await resend.emails.send({
        from: senderFrom,
        to: [lead.author_email],
        bcc: ["williamxwang03@gmail.com"],
        subject: lead.draft_subject,
        html: lead.draft_html,
      });

      if (result.error) {
        errors.push(`${lead.author_email}: ${result.error.message}`);
        skipped++;
        continue;
      }

      // Save to emails table
      const threadId = `thread_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      await supabase.from("emails").insert({
        from: senderFrom,
        to: lead.author_email,
        subject: lead.draft_subject,
        html: lead.draft_html,
        resend_id: result.data?.id || null,
        status: "sent",
        thread_id: threadId,
      });

      // Update lead status
      await supabase
        .from("pipeline_leads")
        .update({ status: "sent", sent_at: new Date().toISOString() })
        .eq("id", id);

      // Record contact history
      await recordContact(lead.author_email, lead.title, lead.draft_subject);

      sent++;

      // Rate limit: 2 per second
      await new Promise((r) => setTimeout(r, 500));
    }

    return NextResponse.json({ sent, skipped, errors });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Batch send failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
