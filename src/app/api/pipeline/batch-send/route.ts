import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { resend } from "@/lib/resend";
import { recordContact } from "@/lib/scanner";
import { getRep } from "@/lib/assignment";
import { checkSendAllowed } from "@/lib/contact-guard";
import { MIN_AGE_DAYS, leadAgeDays } from "@/lib/policy";
import { canonicalizeEmail } from "@/lib/email-id";
import { requireSession } from "@/lib/auth-helpers";
import { DAILY_OVERRIDE_CAP, countOverridesTodayByRep } from "@/lib/override-quota";

// Vercel Pro allows up to 300s per function. At ~1.2s per send (Resend
// round-trip + 100ms inter-send throttle + DB writes) this comfortably
// handles a full 200-lead batch. If you downgrade to Hobby (60s cap)
// this MUST come back down to ~50 or the function will timeout mid-loop
// and leave leads stuck at 'sending'.
export const maxDuration = 300;

const BATCH_MAX = 200;
// Resend's default rate limit is 10 req/s. 100ms gap = 10 req/s on the
// nose; the per-send work (DB update + Resend call) adds another ~400ms
// so actual throughput stays ~2 req/s. Safe margin.
const INTER_SEND_DELAY_MS = 100;

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

    if (ids.length > BATCH_MAX) {
      return NextResponse.json(
        { error: `Max ${BATCH_MAX} at a time. Split into multiple batches.` },
        { status: 400 },
      );
    }

    const overrideSet = new Set(Array.isArray(overrides) ? overrides : []);

    // Quota: fetch today's count once, up front. We'll decrement the
    // remaining budget in-memory as the loop consumes overrides — avoiding
    // a DB round-trip per lead. If the whole batch doesn't use any
    // overrides (overrideSet is empty), we skip the session+count entirely.
    let overrideBudget = Infinity;
    let overridesUsedThisBatch = 0;
    if (overrideSet.size > 0) {
      const session = await requireSession(req);
      const actingRepId = session?.repId ?? null;
      if (actingRepId) {
        const used = (await countOverridesTodayByRep(actingRepId)) ?? 0;
        overrideBudget = Math.max(0, DAILY_OVERRIDE_CAP - used);
      }
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

      // 7-day age gate (per-lead override allowed). Anchored on created_at.
      const ageDays = leadAgeDays(lead.created_at);
      const needsOverride = ageDays < MIN_AGE_DAYS;
      const clientAskedOverride = overrideSet.has(id);
      if (needsOverride && !clientAskedOverride) {
        skipped++;
        blocks["age_gate"] = (blocks["age_gate"] || 0) + 1;
        continue;
      }
      // Quota: every gated lead that the client wants to override consumes
      // a budget unit. When budget hits 0 we start skipping them with a
      // dedicated reason so the caller can surface "X leads blocked by
      // daily override cap."
      const willUseOverride = needsOverride && clientAskedOverride;
      if (willUseOverride && overrideBudget <= 0) {
        skipped++;
        blocks["daily_override_limit"] = (blocks["daily_override_limit"] || 0) + 1;
        continue;
      }

      const guard = await checkSendAllowed(lead, { override: clientAskedOverride });
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
        .update({
          status: "sent",
          sent_at: new Date().toISOString(),
          thread_id: threadId,
          override_used: willUseOverride,
        })
        .eq("id", id);
      if (leadUpdateErr) {
        console.error("batch pipeline_leads update failed", { id, err: leadUpdateErr });
      }
      // Only decrement the in-memory budget if override_used actually
      // landed in the DB. If the update failed, the row still has
      // override_used=false — tomorrow's COUNT query wouldn't count this
      // send, so we shouldn't pretend to have spent a slot either.
      // The email already went out regardless; worst case is one extra
      // override fits into the cap, which is better than losing count
      // integrity for future batches.
      if (willUseOverride && !leadUpdateErr) {
        overrideBudget--;
        overridesUsedThisBatch++;
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

      // Throttle between sends to respect Resend's 10 req/s limit.
      await new Promise((r) => setTimeout(r, INTER_SEND_DELAY_MS));
    }

    return NextResponse.json({ sent, skipped, errors, blocks, overridesUsed: overridesUsedThisBatch });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Batch send failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
