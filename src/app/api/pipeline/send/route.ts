import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { resend } from "@/lib/resend";
import { recordContact } from "@/lib/scanner";
import { getRep } from "@/lib/assignment";
import { checkSendAllowed, SEND_MIN_AGE_DAYS, CONTACT_DEDUP_DAYS } from "@/lib/contact-guard";
import { MIN_AGE_DAYS, leadAgeDays } from "@/lib/policy";
import { canonicalizeEmail } from "@/lib/email-id";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { id, override } = body as { id?: string; override?: boolean };

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

    // 7-day age gate (hard enforcement). Anchored on lead.created_at so
    // newly-imported leads cool off in the queue before going out, even if
    // the underlying paper is older. Operators can pass {override: true}
    // per-lead from the UI to bypass.
    if (!override) {
      const ageDays = leadAgeDays(lead.created_at);
      if (ageDays < MIN_AGE_DAYS) {
        return NextResponse.json(
          {
            error: `Lead is ${ageDays.toFixed(1)} days old, minimum is ${MIN_AGE_DAYS}. Pass {override: true} per lead to send anyway.`,
            code: "age_gate",
            leadId: id,
            ageDays,
          },
          { status: 422 },
        );
      }
    }

    const guard = await checkSendAllowed(lead);
    if (!guard.ok) {
      const messages: Record<string, string> = {
        bad_status: `Lead status is '${"status" in guard ? guard.status : ""}', must be 'ready'`,
        no_draft: "Lead has no draft",
        too_new: `Paper must be at least ${SEND_MIN_AGE_DAYS} days old`,
        already_contacted: `Recipient was contacted within the last ${CONTACT_DEDUP_DAYS} days`,
        paper_already_contacted: `A co-author of this paper was contacted within the last ${CONTACT_DEDUP_DAYS} days`,
      };
      const httpStatus = guard.code === "bad_status" || guard.code === "no_draft" ? 400 : 409;
      return NextResponse.json(
        { ...guard, error: messages[guard.code] },
        { status: httpStatus },
      );
    }

    // Optimistic claim: flip ready → sending atomically. If rowcount is 0,
    // another request already claimed this lead — bail before hitting Resend.
    const { data: claimed, error: claimErr } = await supabase
      .from("pipeline_leads")
      .update({ status: "sending" })
      .eq("id", id)
      .eq("status", "ready")
      .select("id")
      .maybeSingle();
    if (claimErr || !claimed) {
      return NextResponse.json(
        { error: "Lead already being sent or not in 'ready' state", code: "race" },
        { status: 409 },
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

    // Canonicalize at send time too — older rows pre-date the import-side
    // canonicalization, so we still catch Gmail aliases / +tags / mixed case.
    const toEmail = canonicalizeEmail(lead.author_email as string);
    const result = await resend.emails.send({
      from: senderFrom,
      to: [toEmail],
      cc: ["williamxwang03@gmail.com"],
      subject: lead.draft_subject,
      html: lead.draft_html,
    });

    if (result.error) {
      await supabase.from("pipeline_leads").update({ status: "ready" }).eq("id", id);
      return NextResponse.json({ error: result.error.message }, { status: 500 });
    }

    // Resend accepted the email. From here on, every step is best-effort —
    // we must NOT return 500 to the user because the email already went out.
    // Mark the lead sent BEFORE writing the emails row so a failure in the
    // emails insert doesn't strand the lead at status='sending'.
    const { error: leadUpdateErr } = await supabase
      .from("pipeline_leads")
      .update({ status: "sent", sent_at: new Date().toISOString() })
      .eq("id", id);
    if (leadUpdateErr) {
      console.error("pipeline_leads update failed after send", { id, err: leadUpdateErr });
    }

    // Save to emails table (audit log). Failure here is a logging gap, not a
    // user-facing error — the email was delivered to Resend successfully.
    const threadId = `thread_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const { data: email, error: emailError } = await supabase
      .from("emails")
      .insert({
        from: senderFrom,
        to: toEmail,
        subject: lead.draft_subject,
        html: lead.draft_html,
        resend_id: result.data?.id || null,
        status: "sent",
        thread_id: threadId,
        paper_arxiv_id: lead.arxiv_id ?? null,
      })
      .select()
      .single();
    if (emailError) {
      console.error("emails insert failed after Resend success", { id, resendId: result.data?.id, err: emailError });
    }

    // Contact history bookkeeping — fire-and-forget so the response doesn't
    // wait on the persons table upsert (which is the slow hop).
    recordContact(toEmail, lead.title, lead.draft_subject, lead.arxiv_id ?? null).catch((e) => {
      console.error("recordContact failed (non-blocking)", e);
    });

    return NextResponse.json({
      success: true,
      emailId: email?.id ?? null,
      resendId: result.data?.id ?? null,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to send email";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
