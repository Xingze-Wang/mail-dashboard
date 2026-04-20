import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { resend } from "@/lib/resend";
import { recordContact } from "@/lib/scanner";
import { getRep } from "@/lib/assignment";
import { checkSendAllowed } from "@/lib/contact-guard";
import { MIN_AGE_DAYS, leadAgeDays } from "@/lib/policy";

/**
 * POST /api/pipeline/batch-send
 * Send multiple leads at once.
 * Body: { ids: string[], overrides?: string[] }
 *   - `overrides` is an opt-in list of lead ids permitted to bypass the
 *     7-day age gate. Any id not present in overrides is rejected if it
 *     is younger than MIN_AGE_DAYS.
 */
export async function POST(req: NextRequest) {
  try {
    const { ids, overrides } = (await req.json()) as {
      ids?: string[];
      overrides?: string[];
    };

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ error: "Missing ids array" }, { status: 400 });
    }

    if (ids.length > 50) {
      return NextResponse.json({ error: "Max 50 at a time" }, { status: 400 });
    }

    const overrideSet = new Set(Array.isArray(overrides) ? overrides : []);

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

      // 7-day age gate (per-lead override allowed). Anchored on created_at.
      if (!overrideSet.has(id)) {
        const ageDays = leadAgeDays(lead.created_at);
        if (ageDays < MIN_AGE_DAYS) {
          skipped++;
          blocks["age_gate"] = (blocks["age_gate"] || 0) + 1;
          continue;
        }
      }

      const guard = await checkSendAllowed(lead);
      if (!guard.ok) {
        skipped++;
        blocks[guard.code] = (blocks[guard.code] || 0) + 1;
        continue;
      }

      // Optimistic claim: ready → sending. Skip if someone else already took it.
      const { data: claimed } = await supabase
        .from("pipeline_leads")
        .update({ status: "sending" })
        .eq("id", id)
        .eq("status", "ready")
        .select("id")
        .maybeSingle();
      if (!claimed) {
        skipped++;
        blocks["race"] = (blocks["race"] || 0) + 1;
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
        await supabase.from("pipeline_leads").update({ status: "ready" }).eq("id", id);
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
