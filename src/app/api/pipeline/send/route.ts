import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { resend } from "@/lib/resend";
import { recordContact } from "@/lib/scanner";
import { getRep } from "@/lib/assignment";
import { checkSendAllowed, SEND_MIN_AGE_DAYS, CONTACT_DEDUP_DAYS, claimContact, confirmClaim, releaseClaim } from "@/lib/contact-guard";
import { MIN_AGE_DAYS, leadAgeDays } from "@/lib/policy";
import { canonicalizeEmail } from "@/lib/email-id";
import { checkBlocked } from "@/lib/blocklist";
import { requireSession } from "@/lib/auth-helpers";
import { checkSingleSendAllowed } from "@/lib/trust-level";
import { loadEffectiveTemplate, resolveLatePlaceholders } from "@/lib/template-assembler";
import { freshenDraftForRep } from "@/lib/draft-freshen";
import { buildQuotaCheck, countOverridesTodayByRep } from "@/lib/override-quota";

export async function POST(req: NextRequest) {
  try {
    // Auth FIRST — previously this handler parsed the body, looked up the
    // lead, and only consulted the session mid-way through. A missing/
    // expired cookie silently made `actingRepId` null, which disabled the
    // quota cap. Now unauthenticated requests are rejected up front.
    const session = await requireSession(req);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const {
      id, override,
      // Edit-capture fields (sent from Review-mode textarea):
      // - editedSubject / editedHtml: the actual text being sent (may differ
      //   from the AI's draft in the DB if sales typed in the textarea)
      // - editReasons: 0-N tags from the "why did you edit?" modal
      // - editNote: optional free text
      editedSubject, editedHtml, editReasons, editNote,
    } = body as {
      id?: string; override?: boolean;
      editedSubject?: string; editedHtml?: string;
      editReasons?: string[]; editNote?: string;
    };

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

    // Ownership check — non-admin/senior users can only send THEIR OWN
    // leads. Previously any sales could POST another rep's lead id and
    // the send would go out under that rep's sender. 404 (not 403) to
    // avoid leaking which lead ids exist outside the caller's scope.
    const isPrivileged = session.role === "admin";
    if (!isPrivileged && lead.assigned_rep_id !== session.repId) {
      return NextResponse.json({ error: "Lead not found" }, { status: 404 });
    }

    const actingRepId = session.repId;

    // Training-wheels daily-send-cap. Admin/senior are uncapped (returns
    // ok). New reps get blocked here BEFORE any Resend round-trip so we
    // don't burn rate-limit budget on rejected sends.
    const tw = await checkSingleSendAllowed(actingRepId);
    if (!tw.ok) {
      return NextResponse.json(
        {
          error: tw.reason,
          tier: tw.capabilities.tier,
          capabilities: tw.capabilities,
        },
        { status: 403 },
      );
    }

    // `override` at this point is just the intent from the client. We only
    // count it as a real override (and consume quota) if the lead actually
    // needs one — i.e. it's inside the 7-day window. An "override=true"
    // click on an already-old lead is a no-op, shouldn't eat quota.
    const ageDays = leadAgeDays(lead.created_at);
    const needsOverride = ageDays < MIN_AGE_DAYS;
    const overrideWillBeUsed = needsOverride && !!override;

    // 7-day age gate (hard enforcement). Anchored on lead.created_at so
    // newly-imported leads cool off in the queue before going out, even if
    // the underlying paper is older. Operators can pass {override: true}
    // per-lead from the UI to bypass.
    if (needsOverride && !override) {
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

    // Daily override cap — per rep, Beijing-day boundary. Only enforced
    // when the send would actually consume an override; normal sends pass
    // straight through.
    if (overrideWillBeUsed && actingRepId) {
      const used = (await countOverridesTodayByRep(actingRepId)) ?? 0;
      const quota = buildQuotaCheck(used);
      if (!quota.ok) {
        return NextResponse.json(
          {
            error: `今日 7-day override 额度已用完 (${quota.used}/${quota.cap})。明天 Beijing 00:00 重置 — 或让这条 lead 自然等到 7 天以上再发。`,
            code: "daily_override_limit",
            quota,
          },
          { status: 429 },
        );
      }
    }

    // Defensive: the scanner can produce rows with null author_email (PDF
    // parse miss). Without this guard `canonicalizeEmail(null)` returns
    // "" and we'd send to Resend with `to: [""]` — either silent failure
    // or a cryptic 500. Reject at the UI layer with a clear reason.
    const rawAuthorEmail = lead.author_email as string | null | undefined;
    if (!rawAuthorEmail || !rawAuthorEmail.includes("@")) {
      return NextResponse.json(
        {
          error: "这条 lead 没有有效的 email 地址 — scanner 没抓到。Skip 或 flag 让 admin 补。",
          code: "no_recipient",
        },
        { status: 400 },
      );
    }
    // Defensive: refuse to send a draft that's empty/null. The server
    // shouldn't treat the string "null" as a valid subject.
    const hasDraftSubject = typeof lead.draft_subject === "string" && lead.draft_subject.trim().length > 0;
    const hasDraftHtml = typeof lead.draft_html === "string" && lead.draft_html.trim().length > 0;
    const hasEditedSubject = typeof editedSubject === "string" && editedSubject.trim().length > 0;
    const hasEditedHtml = typeof editedHtml === "string" && editedHtml.trim().length > 0;
    if (!(hasEditedSubject || hasDraftSubject) || !(hasEditedHtml || hasDraftHtml)) {
      return NextResponse.json(
        { error: "这条 lead 没有草稿（subject 或 body 空）。等 enrichment 跑完再试。", code: "no_draft" },
        { status: 400 },
      );
    }

    // Hard blocklist check — overrides everything except missing-id (above).
    // Block reason is surfaced so sales sees WHY a send was rejected.
    const blockHit = await checkBlocked(rawAuthorEmail);
    if (blockHit) {
      return NextResponse.json(
        {
          error: `这位收件人在 blocklist 里 — 原因: ${blockHit.reason || "（未填写）"}。如果你觉得是误判，找 senior/admin review。`,
          code: "blocked",
          blockedBy: blockHit.blocked_by,
          blockedAt: blockHit.blocked_at,
        },
        { status: 409 },
      );
    }

    const guard = await checkSendAllowed(lead, { override: overrideWillBeUsed });
    if (!guard.ok) {
      // Actionable error messages — each one tells sales WHAT blocked them
      // and WHAT to do next. Generic "paper not ready" used to leave them
      // clicking Send in a loop with no understanding of why.
      const messages: Record<string, string> = {
        bad_status: `这条 lead 已经不是 'ready' 状态（可能已经被发过或 skip 了）。刷新一下就行。`,
        no_draft: "这条 lead 没有草稿 — 等 enrichment 跑完再试。",
        too_new: `Paper 发表时间太近（<${SEND_MIN_AGE_DAYS}天）。勾上 Override 7-day rule 就能发。`,
        already_contacted: `这位收件人在过去 ${CONTACT_DEDUP_DAYS} 天内已经被联系过了（可能是另一位 rep）。跳过这条，不要重复联系。`,
        paper_already_contacted: `这篇 paper 的合作者在过去 ${CONTACT_DEDUP_DAYS} 天内已经被联系过（可能是另一位 rep）。跳过这条。`,
      };
      const httpStatus = guard.code === "no_draft" ? 400 : 409;
      return NextResponse.json(
        { ...guard, error: messages[guard.code] ?? `Send blocked: ${guard.code}` },
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

    // Resolve the sender identity. Priority: the lead's assigned rep →
    // the acting session's rep → env default. The old code fell straight
    // through to env on any getRep() miss, which produced
    // `"undefined <undefined>"` when the env vars weren't set.
    let senderFrom: string | null = null;
    if (lead.assigned_rep_id) {
      const rep = await getRep(lead.assigned_rep_id).catch(() => null);
      if (rep?.sender_name && rep?.sender_email) {
        senderFrom = `${rep.sender_name} <${rep.sender_email}>`;
      }
    }
    if (!senderFrom) {
      const rep = await getRep(actingRepId).catch(() => null);
      if (rep?.sender_name && rep?.sender_email) {
        senderFrom = `${rep.sender_name} <${rep.sender_email}>`;
      }
    }
    if (!senderFrom) {
      const envName = process.env.SENDER_NAME;
      const envEmail = process.env.SENDER_EMAIL;
      if (envName && envEmail) {
        senderFrom = `${envName} <${envEmail}>`;
      }
    }
    if (!senderFrom) {
      await supabase.from("pipeline_leads").update({ status: "ready" }).eq("id", id);
      return NextResponse.json(
        { error: "Cannot resolve sender identity — no rep row and no env default." },
        { status: 500 },
      );
    }

    // Canonicalize at send time too — older rows pre-date the import-side
    // canonicalization, so we still catch Gmail aliases / +tags / mixed case.
    const toEmail = canonicalizeEmail(rawAuthorEmail);
    // Use the edited content if the client supplied it (Review-mode textarea).
    // Falls back to whatever's in the DB (Browse-mode quick send). We
    // already verified both values are non-empty strings above.
    let finalSubject: string = hasEditedSubject ? (editedSubject as string) : (lead.draft_subject as string);
    let finalHtml: string = hasEditedHtml ? (editedHtml as string) : (lead.draft_html as string);

    // Draft staleness check: if the draft was rendered with an
    // out-of-date rep name (e.g. pre-rename "Chenyu" still baked in),
    // swap to the current sender_name. Cheap string-replace; no LLM.
    // Persist the freshened version back to pipeline_leads so future
    // reads see it. Only run when the user didn't edit — otherwise we'd
    // be overwriting their explicit input.
    // Resolve {{REP_*}} late-binding placeholders against the rep that's
    // ACTUALLY sending right now (assigned > acting). This is the new
    // approach replacing eager string baking — drafts stored in
    // pipeline_leads carry sentinels, NOT names. So reassignment is
    // free and the freshenDraftForRep sweep below is now belt-and-
    // suspenders for any pre-migration drafts that still have baked
    // strings from before this commit.
    const senderNameOnly = (() => {
      const m = senderFrom.match(/^(.*?)\s*<.*>$/);
      return (m?.[1] ?? senderFrom).trim();
    })();
    const repForResolve =
      (lead.assigned_rep_id ? await getRep(lead.assigned_rep_id).catch(() => null) : null) ??
      (await getRep(actingRepId).catch(() => null));
    if (!hasEditedHtml && !hasEditedSubject) {
      // Order matters:
      //   (1) Freshen first on the STORED form (placeholders + any
      //       legacy baked names). Persist this back to pipeline_leads
      //       so future reads keep the placeholder structure AND get
      //       the legacy-name fix.
      //   (2) THEN resolve {{REP_*}} for THIS send. We don't write the
      //       resolved form back — it's send-time only.
      const fresh = await freshenDraftForRep({
        draftHtml: finalHtml,
        draftSubject: finalSubject,
        currentSenderName: senderNameOnly,
        currentWechatId: repForResolve?.wechat_id ?? null,
      });
      if (fresh.swapped) {
        console.log(
          `[send] legacy-freshened lead=${id}: swapped "${fresh.swappedFrom}" → "${senderNameOnly}"`,
        );
        finalHtml = fresh.html;
        finalSubject = fresh.subject;
        await supabase
          .from("pipeline_leads")
          .update({ draft_html: finalHtml, draft_subject: finalSubject })
          .eq("id", id);
      }
      // Now resolve {{REP_*}} sentinels for the actual send. NOT
      // persisted — placeholders stay in DB.
      const resolved = resolveLatePlaceholders({
        html: finalHtml,
        subject: finalSubject,
        repName: senderNameOnly,
        repWechat: repForResolve?.wechat_id ?? null,
      });
      finalHtml = resolved.html;
      finalSubject = resolved.subject;
    }
    // Atomic claim — hard-closes the double-send race. checkSendAllowed
    // above is a soft check that can race; this is the hard gate. If
    // another send for the same recipient is already in flight, the
    // INSERT fails with 23505 and we abort BEFORE calling Resend. See
    // mig 079 and contact-guard.ts:claimContact.
    const claim = await claimContact({
      email: toEmail,
      leadId: id,
      actorRepId: actingRepId ?? null,
      paperArxivId: (lead.arxiv_id as string | null) ?? null,
    });
    if (!claim.claimed) {
      await supabase.from("pipeline_leads").update({ status: "ready" }).eq("id", id);
      if (claim.reason === "duplicate") {
        return NextResponse.json(
          {
            error: `这位收件人正在被另一封邮件锁定（可能是并行发送或本月已联系）。已经把这条 lead 回滚到 ready，不要重复联系。`,
            code: "already_claimed",
          },
          { status: 409 },
        );
      }
      return NextResponse.json(
        { error: `Claim failed (db): ${claim.error ?? "unknown"}`, code: "claim_db_error" },
        { status: 500 },
      );
    }

    // Wrap Resend in try/catch — on a thrown error (network reset, DNS,
    // lib exception), the old code fell through to the outer catch and
    // left the lead stuck at status='sending' forever. Roll back
    // explicitly on both `result.error` and thrown cases. We also
    // release the contact_claims row so a retry isn't permanently
    // blocked by a transient Resend failure.
    let result;
    try {
      result = await resend.emails.send({
        from: senderFrom,
        to: [toEmail],
        cc: ["williamxwang03@gmail.com"],
        subject: finalSubject,
        html: finalHtml,
      });
    } catch (e) {
      await releaseClaim(claim.claimId);
      await supabase.from("pipeline_leads").update({ status: "ready" }).eq("id", id);
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ error: `Resend threw: ${msg}. Lead returned to 'ready'.` }, { status: 500 });
    }

    if (result.error) {
      await releaseClaim(claim.claimId);
      await supabase.from("pipeline_leads").update({ status: "ready" }).eq("id", id);
      return NextResponse.json({ error: result.error.message }, { status: 500 });
    }

    // Resend accepted; promote the claim from tentative → confirmed.
    // From here on we're committed: the email is out, the recipient is
    // dedup-protected for the next 365 days.
    await confirmClaim(claim.claimId, result.data?.id ?? null);

    // Resend accepted the email. From here on, every step is best-effort —
    // we must NOT return 500 to the user because the email already went out.
    // Mark the lead sent BEFORE writing the emails row so a failure in the
    // emails insert doesn't strand the lead at status='sending'.
    // Save thread_id on the lead so "Open thread" can jump to the inbox.
    const threadId = `thread_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    // Levenshtein-ish: normalized edit distance via a fast char-bag diff.
    // Good enough to bucket "tiny tweak" vs "rewrote half" without depending
    // on a Levenshtein lib at the edge. We compare text-stripped versions
    // because the client's textarea-roundtrip (plainToHtml(htmlToPlainText(...)))
    // never matches the original HTML char-for-char — without this we'd flag
    // every unedited send as a heavy rewrite.
    const original = (lead.draft_original_html as string | null) ?? (lead.draft_html as string | null) ?? "";
    const editDistance = approxEditDistance(stripTags(original), stripTags(finalHtml));

    const { error: leadUpdateErr } = await supabase
      .from("pipeline_leads")
      .update({
        status: "sent",
        sent_at: new Date().toISOString(),
        thread_id: threadId,
        // Capture the actual sent text (overwrites the AI's draft, but the
        // draft_original_* snapshot is preserved for diff mining).
        draft_subject: finalSubject,
        draft_html: finalHtml,
        draft_edit_distance: editDistance,
        edit_reasons: Array.isArray(editReasons) ? editReasons : null,
        edit_note: typeof editNote === "string" ? editNote.slice(0, 500) : null,
        // Persisted so the daily-quota query can COUNT today's overrides
        // without a separate counter table.
        override_used: overrideWillBeUsed,
      })
      .eq("id", id);
    if (leadUpdateErr) {
      console.error("pipeline_leads update failed after send", { id, err: leadUpdateErr });
      // Retry once more with just the status flip — this is critical so
      // the lead doesn't stay stuck at 'sending' forever. We're best-
      // effort here because the email already went out.
      const retry = await supabase
        .from("pipeline_leads")
        .update({ status: "sent", sent_at: new Date().toISOString(), thread_id: threadId })
        .eq("id", id);
      if (retry.error) {
        console.error("pipeline_leads retry-update ALSO failed — lead may be stuck", { id, err: retry.error });
      }
    }

    // Record which template was active when this draft was sent
    // (migration 032). Cheap re-lookup at send time — within a few
    // days of scan, the answer matches what was actually used. NULL
    // is fine if loadEffectiveTemplate fails or no template exists.
    let templateId: string | null = null;
    try {
      // Pass lead.id so the A/B split (active vs approved_draft) is
      // deterministic-by-lead. A regenerate on the same lead always
      // hits the same template assignment.
      const tpl = await loadEffectiveTemplate(
        lead.assigned_rep_id ?? null,
        lead.id as string,
      );
      templateId = tpl?.id ?? null;
    } catch {
      // best-effort — template_id is for analytics, not delivery
    }

    const { data: email, error: emailError } = await supabase
      .from("emails")
      .insert({
        from: senderFrom,
        to: toEmail,
        cc: "williamxwang03@gmail.com",
        subject: finalSubject,
        html: finalHtml,
        resend_id: result.data?.id || null,
        status: "sent",
        thread_id: threadId,
        paper_arxiv_id: lead.arxiv_id ?? null,
        // rep_id = OWNER (canonical, migration 014). Used to route
        // inbox views, scope dashboards, etc. Mirrors the lead's
        // assigned_rep_id so ownership is always retrievable off the
        // emails row even if the lead later gets reassigned.
        rep_id: lead.assigned_rep_id ?? actingRepId,
        // actor_rep_id = WHO PERFORMED THE SEND (migration 019). Used
        // for audit and for bounce/reply attribution math that should
        // credit/debit the rep who actually did the work, not the
        // rep who happens to own the lead. Diverges from rep_id when
        // admin/senior sends on behalf of another rep.
        actor_rep_id: actingRepId,
        template_id: templateId,
        // Audit (migration 062): copy the resolved prompt + LLM output
        // captured at draft-queue time. NULL on legacy / Python-supplied
        // drafts that never went through assembleDraft.
        intro_prompt_resolved:
          (lead.draft_intro_prompt_resolved as string | null | undefined) ?? null,
        intro_output: (lead.draft_intro_output as string | null | undefined) ?? null,
      })
      .select()
      .single();
    if (emailError) {
      console.error("emails insert failed after Resend success", { id, resendId: result.data?.id, err: emailError });
    }

    // Contact history bookkeeping — fire-and-forget so the response doesn't
    // wait on the persons table upsert (which is the slow hop). Wrap in a
    // sync try/catch too: if recordContact throws synchronously (bad arg
    // / import-time error) it'd bubble to the outer catch and return 500
    // *after* the email already went out.
    try {
      recordContact(toEmail, lead.title, finalSubject, lead.arxiv_id ?? null).catch((e) => {
        console.error("recordContact failed (non-blocking)", e);
      });
    } catch (e) {
      console.error("recordContact sync throw (non-blocking)", e);
    }

    // Mission progress — also fire-and-forget. The actor (whoever's
    // session this is) gets credit, not the lead owner. Mirrors the
    // actor-vs-owner attribution rule in CLAUDE.md.
    try {
      const { bumpMissionProgress } = await import("@/lib/missions");
      bumpMissionProgress(actingRepId, "send", 1).catch((e) => {
        console.error("bumpMissionProgress failed (non-blocking)", e);
      });
    } catch (e) {
      console.error("bumpMissionProgress sync throw (non-blocking)", e);
    }

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

/** Strip tags + collapse whitespace so the diff measures content, not markup. */
function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

/** Cheap O(n+m) edit-distance approximation: sum of |freq diffs| over chars.
 *  Not true Levenshtein but stable, fast, and sufficient to bucket
 *  "tiny tweak vs heavy rewrite". 0 = identical. */
function approxEditDistance(a: string, b: string): number {
  if (!a && !b) return 0;
  if (a === b) return 0;
  const counts = new Map<string, number>();
  for (const c of a) counts.set(c, (counts.get(c) ?? 0) + 1);
  for (const c of b) counts.set(c, (counts.get(c) ?? 0) - 1);
  let diff = 0;
  for (const v of counts.values()) diff += Math.abs(v);
  return Math.floor(diff / 2);
}
