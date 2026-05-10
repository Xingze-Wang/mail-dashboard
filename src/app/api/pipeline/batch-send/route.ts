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
import { loadEffectiveTemplate, resolveLatePlaceholders } from "@/lib/template-assembler";
import { checkBulkSendAllowed, sendsTodayByRep } from "@/lib/trust-level";
import { freshenDraftForRep } from "@/lib/draft-freshen";

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
    // Auth FIRST — every send must be attributable to a session, so we
    // can enforce per-rep ownership + quota. Prior logic only looked
    // up the session when `overrides` was non-empty, letting unauthed
    // requests skate through for non-override sends.
    const session = await requireSession(req);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
    const { ids, overrides } = body as { ids?: string[]; overrides?: string[] };

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ error: "Missing ids array" }, { status: 400 });
    }

    if (ids.length > BATCH_MAX) {
      return NextResponse.json(
        { error: `Max ${BATCH_MAX} at a time. Split into multiple batches.` },
        { status: 400 },
      );
    }

    const isPrivileged = session.role === "admin";
    const actingRepId = session.repId;

    // Training wheels: gate bulk sends per-rep based on trust_level +
    // total sends. Admins / seniors are always allowed (their tier is
    // 'admin' which has no caps). New reps get blocked here, before any
    // Resend traffic happens.
    const bulkCheck = await checkBulkSendAllowed(actingRepId, ids.length);
    if (!bulkCheck.ok) {
      return NextResponse.json(
        {
          error: bulkCheck.reason,
          tier: bulkCheck.capabilities.tier,
          capabilities: bulkCheck.capabilities,
        },
        { status: 403 },
      );
    }
    // Cache dailySendCap from the upfront check; the per-iteration
    // race-mitigation re-check below uses the same threshold.
    const dailySendCap = bulkCheck.capabilities.dailySendCap;

    const overrideSet = new Set(Array.isArray(overrides) ? overrides : []);

    // Fetch today's override count once up front. We'll decrement the
    // remaining budget in-memory as the loop consumes overrides —
    // avoiding a DB round-trip per lead.
    let overrideBudget = DAILY_OVERRIDE_CAP;
    let overridesUsedThisBatch = 0;
    if (overrideSet.size > 0) {
      const used = (await countOverridesTodayByRep(actingRepId)) ?? 0;
      overrideBudget = Math.max(0, DAILY_OVERRIDE_CAP - used);
    }

    let sent = 0;
    let skipped = 0;
    const errors: string[] = [];
    const blocks: Record<string, number> = {};

    for (const id of ids) {
      try {
      const { data: lead } = await supabase
        .from("pipeline_leads")
        .select("*")
        .eq("id", id)
        .single();

      if (!lead) {
        errors.push(`${id}: not found`);
        blocks["not_found"] = (blocks["not_found"] || 0) + 1;
        skipped++;
        continue;
      }

      // Ownership check — non-privileged users can only batch-send their
      // own leads. Silently skip others' leads; don't count them as
      // errors because the client probably sent the full selected set.
      if (!isPrivileged && lead.assigned_rep_id !== actingRepId) {
        blocks["not_owned"] = (blocks["not_owned"] || 0) + 1;
        skipped++;
        continue;
      }

      // Null-email / null-draft guards. Prevents sending to "" or
      // with a "null" subject.
      const rawAuthorEmail = lead.author_email as string | null | undefined;
      if (!rawAuthorEmail || !rawAuthorEmail.includes("@")) {
        blocks["no_recipient"] = (blocks["no_recipient"] || 0) + 1;
        skipped++;
        continue;
      }
      const hasDraftSubject = typeof lead.draft_subject === "string" && lead.draft_subject.trim().length > 0;
      const hasDraftHtml = typeof lead.draft_html === "string" && lead.draft_html.trim().length > 0;
      if (!hasDraftSubject || !hasDraftHtml) {
        blocks["no_draft"] = (blocks["no_draft"] || 0) + 1;
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
      //
      // Re-check against the LIVE count before every override-consuming
      // send. This protects against the concurrent-batch race: our
      // in-memory budget started from countOverridesTodayByRep() at
      // the top of the request, but a parallel batch could be eating
      // slots at the same time. A cheap per-override COUNT query
      // closes the window from "hundreds of leads" to "one lead".
      const willUseOverride = needsOverride && clientAskedOverride;
      if (willUseOverride) {
        const liveUsed = (await countOverridesTodayByRep(actingRepId)) ?? 0;
        const liveRemaining = Math.max(0, DAILY_OVERRIDE_CAP - liveUsed);
        if (liveRemaining <= 0) {
          skipped++;
          blocks["daily_override_limit"] = (blocks["daily_override_limit"] || 0) + 1;
          continue;
        }
        // Keep the in-memory budget in sync with the live count so
        // the later `overrideBudget--` reflects reality, not drift.
        overrideBudget = Math.min(overrideBudget, liveRemaining);
      }

      const guard = await checkSendAllowed(lead, { override: clientAskedOverride });
      if (!guard.ok) {
        skipped++;
        blocks[guard.code] = (blocks[guard.code] || 0) + 1;
        continue;
      }

      // Race-mitigation re-check on the daily-send cap. The upfront
      // checkBulkSendAllowed only saw a snapshot of "sentToday" at
      // request start; concurrent batches from the same rep could each
      // pass that check and then race past the cap together. Re-querying
      // before each lead narrows the window to one lead per parallel
      // call (same pattern the override-quota code uses on line 142).
      // Skip when admin/senior (dailySendCap === null).
      if (dailySendCap !== null) {
        const liveSent = await sendsTodayByRep(actingRepId);
        if (liveSent + sent >= dailySendCap) {
          skipped++;
          blocks["daily_send_cap"] = (blocks["daily_send_cap"] || 0) + 1;
          continue;
        }
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
      // Send via Resend — wrap in try/catch so a thrown error (network,
      // DNS, rate-limit bomb) rolls this lead back to 'ready' and lets
      // the loop continue to the NEXT lead. Without this the old code
      // would jump to the outer catch, return 500, and abandon every
      // remaining lead in the batch at whatever status they were in —
      // sales would see "1 sent, 2 skipped" with the remaining 100
      // silently dropped.
      // Draft staleness check (same as in /api/pipeline/send): swap
      // out-of-date rep names baked into older drafts. Cheap; no LLM.
      // We skip if there's no draft (caught above) or if the user
      // already short-circuited with edited content. Batch-send doesn't
      // have edit capability — every draft here is from the DB — so we
      // always run it.
      let freshSubject: string = lead.draft_subject as string;
      let freshHtml: string = lead.draft_html as string;
      try {
        const senderNameOnly = (() => {
          const m = senderFrom.match(/^(.*?)\s*<.*>$/);
          return (m?.[1] ?? senderFrom).trim();
        })();
        // Resolve current rep's wechat for the wechat-staleness sweep
        // (mirror of /api/pipeline/send). batch-send caches one rep's
        // wechat once at the top — but reassignments inside a batch
        // are rare enough that re-fetching per-lead is fine. If batch
        // sizes balloon, hoist this lookup outside the loop.
        const repForFresh =
          (lead.assigned_rep_id ? await getRep(lead.assigned_rep_id).catch(() => null) : null) ??
          (await getRep(actingRepId).catch(() => null));
        const fresh = await freshenDraftForRep({
          draftHtml: freshHtml,
          draftSubject: freshSubject,
          currentSenderName: senderNameOnly,
          currentWechatId: repForFresh?.wechat_id ?? null,
        });
        if (fresh.swapped) {
          console.log(
            `[batch-send] freshened lead=${id}: "${fresh.swappedFrom}" → "${senderNameOnly}"`,
          );
          freshHtml = fresh.html;
          freshSubject = fresh.subject;
          await supabase
            .from("pipeline_leads")
            .update({ draft_html: freshHtml, draft_subject: freshSubject })
            .eq("id", id);
        }
        // Resolve {{REP_*}} sentinels for THIS send. Not persisted —
        // pipeline_leads.draft_html keeps the placeholders.
        const resolved = resolveLatePlaceholders({
          html: freshHtml,
          subject: freshSubject,
          repName: senderNameOnly,
          repWechat: repForFresh?.wechat_id ?? null,
        });
        freshHtml = resolved.html;
        freshSubject = resolved.subject;
      } catch (e) {
        // Best-effort: a freshness failure shouldn't block the send.
        console.error(`[batch-send] freshen threw on lead=${id}:`, e);
      }

      let result;
      try {
        result = await resend.emails.send({
          from: senderFrom,
          to: [toEmail],
          cc: ["williamxwang03@gmail.com"],
          subject: freshSubject,
          html: freshHtml,
        });
      } catch (e) {
        await supabase.from("pipeline_leads").update({ status: "ready" }).eq("id", id);
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`${toEmail}: ${msg}`);
        blocks["resend_threw"] = (blocks["resend_threw"] || 0) + 1;
        skipped++;
        continue;
      }

      if (result.error) {
        await supabase.from("pipeline_leads").update({ status: "ready" }).eq("id", id);
        errors.push(`${toEmail}: ${result.error.message}`);
        blocks["resend_error"] = (blocks["resend_error"] || 0) + 1;
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

      // Audit log (best-effort). rep_id mirrors the lead's
      // assigned_rep_id (canonical, migration 014) so scope-by-rep
      // queries can later swap off the fragile `from ilike
      // sender_email` proxy filter.
      // Per-lead lookup so the A/B split between active and
      // approved_draft is deterministic-by-lead (same lead → same
      // template assignment across regenerates). The cache-by-repId
      // optimization is gone here — it'd defeat the per-lead
      // bucketing — but the lookup is one cheap DB read so it's fine.
      let templateId: string | null = null;
      try {
        const tpl = await loadEffectiveTemplate(
          lead.assigned_rep_id ?? null,
          lead.id as string,
        );
        templateId = tpl?.id ?? null;
      } catch {
        // best-effort
      }
      const { error: emailInsertErr } = await supabase.from("emails").insert({
        from: senderFrom,
        to: toEmail,
        cc: "williamxwang03@gmail.com",
        subject: freshSubject,
        html: freshHtml,
        resend_id: result.data?.id || null,
        status: "sent",
        thread_id: threadId,
        paper_arxiv_id: lead.arxiv_id ?? null,
        rep_id: lead.assigned_rep_id ?? actingRepId,
        // Actor (who actually pressed send). See pipeline/send for the
        // rep_id vs actor_rep_id distinction.
        actor_rep_id: actingRepId,
        template_id: templateId,
        // Audit (migration 062): resolved prompt + LLM output captured
        // at draft-queue time. NULL on legacy/Python-supplied drafts.
        intro_prompt_resolved:
          (lead.draft_intro_prompt_resolved as string | null | undefined) ?? null,
        intro_output: (lead.draft_intro_output as string | null | undefined) ?? null,
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
      } catch (iterErr) {
        // A thrown error anywhere in this iteration (getRep DB blip,
        // supabase network glitch, unexpected lead shape) previously
        // jumped to the outer catch and abandoned every remaining lead.
        // Now we log, try to roll the current lead back to 'ready' if we
        // claimed it, and continue.
        console.error("batch iteration threw", { id, err: iterErr });
        await supabase.from("pipeline_leads").update({ status: "ready" }).eq("id", id).eq("status", "sending").then(() => {}, () => {});
        blocks["iteration_error"] = (blocks["iteration_error"] || 0) + 1;
        skipped++;
      }
    }

    // Mission progress — bump once with the full batch count. Same
    // attribution rule as single-send: the actor (this session)
    // gets credit, not the lead owner. Fire-and-forget; mission
    // bookkeeping must never block the response.
    if (sent > 0) {
      try {
        const { bumpMissionProgress } = await import("@/lib/missions");
        bumpMissionProgress(session.repId, "send", sent).catch((e) => {
          console.error("bumpMissionProgress failed (non-blocking)", e);
        });
      } catch (e) {
        console.error("bumpMissionProgress sync throw (non-blocking)", e);
      }
    }

    return NextResponse.json({ sent, skipped, errors, blocks, overridesUsed: overridesUsedThisBatch });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Batch send failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
