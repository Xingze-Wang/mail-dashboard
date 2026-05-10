import { NextRequest, NextResponse } from "next/server";
import { Webhook } from "svix";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";
import { getRep } from "@/lib/assignment";
import { resolveInboundRepId } from "@/lib/inbound-attribution";
import { listEnvelope } from "@/lib/list-envelope";

/** Clean up `to` field — handles JSON array strings like '["a@b.com"]' */
function cleanToField(to: string | null): string {
  if (!to) return "";
  // If it looks like a JSON array, parse and join
  if (to.startsWith("[")) {
    try {
      const arr = JSON.parse(to);
      return Array.isArray(arr) ? arr.join(", ") : to;
    } catch {
      return to;
    }
  }
  return to;
}

export async function POST(req: NextRequest) {
  try {
    // Svix HMAC verification — same shape as /api/webhook. The prior
    // bearer-compare fell open when INBOUND_SECRET was unset (any POST
    // could create fake inbound_emails rows and flip pipeline_leads to
    // 'replied'). Read body raw so the signature can be verified before
    // we parse JSON.
    const secret = process.env.INBOUND_SECRET;
    if (!secret) {
      // Refuse rather than fail-open. Prior code silently accepted every
      // POST in this state; that's how the spoofed-reply vector existed.
      console.error("[inbound] INBOUND_SECRET not configured — refusing");
      return NextResponse.json(
        { error: "Inbound webhook not configured (INBOUND_SECRET unset)" },
        { status: 503 },
      );
    }

    const rawBody = await req.text();
    const svixHeaders: Record<string, string> = {
      "svix-id": req.headers.get("svix-id") || req.headers.get("webhook-id") || "",
      "svix-timestamp": req.headers.get("svix-timestamp") || req.headers.get("webhook-timestamp") || "",
      "svix-signature": req.headers.get("svix-signature") || req.headers.get("webhook-signature") || "",
    };
    try {
      new Webhook(secret).verify(rawBody, svixHeaders);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "verification failed";
      console.error("[inbound] signature rejected:", msg);
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = JSON.parse(rawBody);
    const { from, to, subject, html, text, message_id, in_reply_to, references, headers } = body;

    let threadId: string | null = null;

    if (in_reply_to) {
      const { data: sentEmail } = await supabase
        .from("emails")
        .select("thread_id")
        .eq("message_id", in_reply_to)
        .single();
      if (sentEmail?.thread_id) threadId = sentEmail.thread_id;

      if (!threadId) {
        const { data: prevInbound } = await supabase
          .from("inbound_emails")
          .select("thread_id")
          .eq("message_id", in_reply_to)
          .single();
        if (prevInbound?.thread_id) threadId = prevInbound.thread_id;
      }
    }

    if (!threadId) {
      threadId = `thread_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    }

    const toField = Array.isArray(to) ? to.join(", ") : (to || "");
    const repId = await resolveInboundRepId(toField, threadId);
    const { data: inbound, error } = await supabase
      .from("inbound_emails")
      .insert({
        from: from || "unknown",
        to: toField,
        subject: subject || "(no subject)",
        html: html || null,
        text: text || null,
        message_id: message_id || null,
        in_reply_to: in_reply_to || null,
        references: references || null,
        thread_id: threadId,
        rep_id: repId,
        headers: headers ? JSON.stringify(headers) : null,
      })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Flip the originating pipeline_leads row to status='replied' so
    // metrics / helper / analytics can actually count replies. Until
    // this was wired, `pipeline_leads.status='replied'` was queried in
    // 5+ places but never written anywhere — replied count was always
    // zero. We identify the lead via the sent email's to-address on
    // the thread: find the outbound `emails` row that started this
    // thread, match its `to` to a `pipeline_leads.author_email`.
    //
    // Best-effort. If the lookup fails or no lead matches (spam, out-
    // of-band reply), we just skip — inbound_emails still saved.
    try {
      const { data: outbound } = await supabase
        .from("emails")
        .select("to")
        .eq("thread_id", threadId)
        .not("thread_id", "is", null)
        .order("created_at", { ascending: true })
        .limit(1);
      const outboundToRaw = outbound?.[0]?.to as string | undefined;
      const recipient = outboundToRaw ? cleanToField(outboundToRaw).split(",")[0].trim().toLowerCase() : "";
      if (recipient) {
        // Only flip 'sent' → 'replied', and ONLY on the lead tied to
        // this thread. Previously this matched by author_email alone
        // and could flip an unrelated lead to the same email that
        // happened to be in 'sent' state for a different paper.
        await supabase
          .from("pipeline_leads")
          .update({ status: "replied" })
          .eq("thread_id", threadId)
          .ilike("author_email", recipient)
          .eq("status", "sent");
      }
    } catch (err) {
      // Non-fatal — log and continue. Inbound mail is saved regardless.
      console.warn("inbound: pipeline_leads.status='replied' update failed", err);
    }

    return NextResponse.json({ id: inbound.id, threadId });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to process inbound email";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "50");
  const offset = (page - 1) * limit;

  // Auth required + per-sales scoping. Prior logic let unauthenticated
  // callers through to the whole team inbox. Fail-closed now: no
  // session → 401; non-privileged user with no resolvable rep row →
  // empty.
  const session = await requireSession(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const isPrivileged = session.role === "admin";

  // Per-rep scope: a row is "this rep's" if EITHER
  //   (a) inbound_emails.rep_id = session.repId  (canonical, stamped by
  //       resolveInboundRepId at write time), OR
  //   (b) the inbound's thread_id is one this rep sent on (covers
  //       legacy rows written before rep_id was added in migration 014,
  //       and rows where the inbound came in on a thread but the
  //       resolver couldn't pin a rep, e.g. team-alias To).
  // Previously we ONLY used (b) — which silently hid correctly
  // attributed inbound from the rep when the originating outbound was
  // missing or had no thread_id link. That's the "replies in the wrong
  // mailbox" symptom.
  let allowedThreadIds: string[] | null = null;
  if (!isPrivileged) {
    const rep = await getRep(session.repId);
    if (!rep?.sender_email) {
      return NextResponse.json({
        emails: [],
        total: 0,
        page,
        limit,
        ...listEnvelope({ scannedTotal: 0, requestedTotal: 0, source: "supabase:inbound_emails" }),
      });
    }
    const { data: outbound } = await supabase
      .from("emails")
      .select("thread_id")
      .or(`rep_id.eq.${session.repId},from.ilike.%${rep.sender_email}%`)
      .not("thread_id", "is", null);
    allowedThreadIds = Array.from(
      new Set(
        (outbound ?? [])
          .map((r) => r.thread_id as string | null)
          .filter((t): t is string => !!t),
      ),
    );
  }

  // Build the per-rep OR filter once: "rep_id = X OR thread_id IN (...)".
  // Postgrest .or() takes a comma-separated string of filters. List
  // values inside .in.() must be paren-wrapped. Quote thread ids so any
  // commas in the id string don't terminate the list early.
  let scopeFilter: string | null = null;
  if (!isPrivileged) {
    const parts = [`rep_id.eq.${session.repId}`];
    if (allowedThreadIds && allowedThreadIds.length > 0) {
      parts.push(`thread_id.in.(${allowedThreadIds.map((t) => `"${t}"`).join(",")})`);
    }
    scopeFilter = parts.join(",");
  }

  let listQuery = supabase
    .from("inbound_emails")
    .select()
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  let countQuery = supabase
    .from("inbound_emails")
    .select("*", { count: "exact", head: true });
  if (scopeFilter) {
    listQuery = listQuery.or(scopeFilter);
    countQuery = countQuery.or(scopeFilter);
  }
  const [{ data: emails }, { count: total }] = await Promise.all([listQuery, countQuery]);

  // Map snake_case DB fields to camelCase for frontend
  const mapped = (emails || []).map((e) => ({
    id: e.id,
    from: e.from,
    to: cleanToField(e.to),
    subject: e.subject,
    html: e.html,
    text: e.text,
    isRead: e.is_read,
    createdAt: e.created_at,
    messageId: e.message_id,
    threadId: e.thread_id,
  }));

  return NextResponse.json({
    emails: mapped,
    total: total ?? mapped.length,
    page,
    limit,
    ...listEnvelope({
      scannedTotal: mapped.length,
      requestedTotal: total ?? undefined,
      cap: offset + limit,
      source: "supabase:inbound_emails",
    }),
  });
}
