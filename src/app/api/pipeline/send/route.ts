import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { resend } from "@/lib/resend";
import { recordContact } from "@/lib/scanner";
import { getRep } from "@/lib/assignment";
import { checkSendAllowed, SEND_MIN_AGE_DAYS, CONTACT_DEDUP_DAYS } from "@/lib/contact-guard";
import { MIN_AGE_DAYS, leadAgeDays } from "@/lib/policy";
import { canonicalizeEmail } from "@/lib/email-id";
import { checkBlocked } from "@/lib/blocklist";
import { requireSession } from "@/lib/auth-helpers";
import { buildQuotaCheck, countOverridesTodayByRep } from "@/lib/override-quota";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
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

    // Resolve the acting rep from the session. The daily override cap is
    // keyed on the authenticated user (not the lead's assigned_rep_id),
    // because the person clicking Send is who's spending the quota.
    const session = await requireSession(req);
    const actingRepId = session?.repId ?? null;

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

    // Hard blocklist check — overrides everything except missing-id (above).
    // Block reason is surfaced so sales sees WHY a send was rejected.
    const blockHit = await checkBlocked((lead.author_email as string) ?? "");
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
    // Use the edited content if the client supplied it (Review-mode textarea).
    // Falls back to whatever's in the DB (Browse-mode quick send).
    const finalSubject = (editedSubject ?? lead.draft_subject) as string;
    const finalHtml = (editedHtml ?? lead.draft_html) as string;
    // Wrap Resend in try/catch — on a thrown error (network reset, DNS,
    // lib exception), the old code fell through to the outer catch and
    // left the lead stuck at status='sending' forever. Roll back
    // explicitly on both `result.error` and thrown cases.
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
      await supabase.from("pipeline_leads").update({ status: "ready" }).eq("id", id);
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ error: `Resend threw: ${msg}. Lead returned to 'ready'.` }, { status: 500 });
    }

    if (result.error) {
      await supabase.from("pipeline_leads").update({ status: "ready" }).eq("id", id);
      return NextResponse.json({ error: result.error.message }, { status: 500 });
    }

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
      })
      .select()
      .single();
    if (emailError) {
      console.error("emails insert failed after Resend success", { id, resendId: result.data?.id, err: emailError });
    }

    // Contact history bookkeeping — fire-and-forget so the response doesn't
    // wait on the persons table upsert (which is the slow hop).
    recordContact(toEmail, lead.title, finalSubject, lead.arxiv_id ?? null).catch((e) => {
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
