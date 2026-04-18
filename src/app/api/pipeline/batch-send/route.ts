import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { resend } from "@/lib/resend";
import { recordContact } from "@/lib/scanner";
import { getRep } from "@/lib/assignment";
import { checkSendAllowed } from "@/lib/contact-guard";

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

    let sent = 0;
    let skipped = 0;
    const errors: string[] = [];
    const blocks: Record<string, number> = {};

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

      const guard = await checkSendAllowed(lead);
      if (!guard.ok) {
        skipped++;
        blocks[guard.code] = (blocks[guard.code] || 0) + 1;
        continue;
      }

      // Look up assigned rep for this lead
      let senderFrom = `${process.env.SENDER_NAME} <${process.env.SENDER_EMAIL}>`;
      if (lead.assigned_rep_id) {
        const rep = await getRep(lead.assigned_rep_id);
        if (rep) {
          senderFrom = `${rep.sender_name} <${rep.sender_email}>`;
        }
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

    return NextResponse.json({ sent, skipped, errors, blocks });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Batch send failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
