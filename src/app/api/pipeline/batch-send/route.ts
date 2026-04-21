import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { resend } from "@/lib/resend";
import { recordContact } from "@/lib/scanner";
import { getRep } from "@/lib/assignment";
import { checkSendAllowed } from "@/lib/contact-guard";
import { MIN_AGE_DAYS, leadAgeDays } from "@/lib/policy";
import { canonicalizeEmail } from "@/lib/email-id";

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

      const toEmail = canonicalizeEmail(lead.author_email as string);
      // Send via Resend
      const result = await resend.emails.send({
        from: senderFrom,
        to: [toEmail],
        cc: ["williamxwang03@gmail.com"],
        subject: lead.draft_subject,
        html: lead.draft_html,
      });

      if (result.error) {
        await supabase.from("pipeline_leads").update({ status: "ready" }).eq("id", id);
        errors.push(`${toEmail}: ${result.error.message}`);
        skipped++;
        continue;
      }

      // Resend accepted — mark the lead sent FIRST so a downstream failure
      // in the emails insert doesn't strand it at status='sending'. We also
      // persist thread_id here so "Open thread" works on the lead row later.
      const threadId = `thread_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      const { error: leadUpdateErr } = await supabase
        .from("pipeline_leads")
        .update({ status: "sent", sent_at: new Date().toISOString(), thread_id: threadId })
        .eq("id", id);
      if (leadUpdateErr) {
        console.error("batch pipeline_leads update failed", { id, err: leadUpdateErr });
      }

      // Audit log (best-effort).
      const { error: emailInsertErr } = await supabase.from("emails").insert({
        from: senderFrom,
        to: toEmail,
        cc: "williamxwang03@gmail.com",
        subject: lead.draft_subject,
        html: lead.draft_html,
        resend_id: result.data?.id || null,
        status: "sent",
        thread_id: threadId,
        paper_arxiv_id: lead.arxiv_id ?? null,
      });
      if (emailInsertErr) {
        console.error("batch emails insert failed", { id, resendId: result.data?.id, err: emailInsertErr });
      }

      // Record contact history (best-effort).
      try {
        await recordContact(toEmail, lead.title, lead.draft_subject, lead.arxiv_id ?? null);
      } catch (e) {
        console.error("batch recordContact failed", { id, err: String(e) });
      }

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
