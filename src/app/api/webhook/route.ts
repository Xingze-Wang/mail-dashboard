import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { resend } from "@/lib/resend";
import { Webhook } from "svix";
import { mapResendEventToStatus } from "@/lib/status";
import { resolveInboundRepId } from "@/lib/inbound-attribution";

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();

    // Resend uses Svix webhook signing. Headers: svix-id, svix-timestamp,
    // svix-signature (or webhook-* aliases). Signature is HMAC-SHA256 of
    // `${id}.${ts}.${rawBody}` base64-encoded as `v1,<sig>`.
    //
    // The constructor `new Webhook(secret)` itself can throw on a
    // malformed secret (e.g. wrong byte length, missing whsec_ prefix
    // when Svix expects raw base64). That throw was previously NOT
    // caught here and bubbled to the outer 500 — Resend's dashboard
    // shows "Input buffers must have the same byte length" failures
    // because of this. We now wrap construction too, AND return 200
    // on signature failure so Resend stops dead-lettering events while
    // the secret is being rotated. The status update path is gated by
    // a successful verify so unsigned/bogus events still don't write.
    const secret = process.env.RESEND_WEBHOOK_SECRET;
    let verified = false;
    if (secret) {
      const headers: Record<string, string> = {
        "svix-id": req.headers.get("svix-id") || req.headers.get("webhook-id") || "",
        "svix-timestamp": req.headers.get("svix-timestamp") || req.headers.get("webhook-timestamp") || "",
        "svix-signature": req.headers.get("svix-signature") || req.headers.get("webhook-signature") || "",
      };
      try {
        new Webhook(secret).verify(rawBody, headers);
        verified = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "verification failed";
        console.error("[webhook] signature rejected:", msg);
        // Return 200 (not 401) so Resend doesn't keep retrying on a
        // secret mismatch — operator should rotate the secret on
        // either side. We log loudly above; webhook_events still gets
        // a row stamped with verified=false so admins can see the
        // failed-verification rate via /api/webhook/health.
        try {
          await supabase.from("webhook_events").insert({
            type: "verification_failed",
            payload: rawBody.slice(0, 2000),
          });
        } catch { /* swallow — diagnostic only */ }
        return NextResponse.json({ ok: false, reason: "signature mismatch — admin should rotate RESEND_WEBHOOK_SECRET" });
      }
    }
    if (!verified && process.env.NODE_ENV === "production") {
      // No secret set in prod = open webhook. Refuse and 200 so we
      // don't pretend events are landing.
      console.error("[webhook] RESEND_WEBHOOK_SECRET not set in production");
      return NextResponse.json({ ok: false, reason: "no secret configured" });
    }

    const body = JSON.parse(rawBody);
    const { type, data } = body;

    if (!type || !data) {
      return NextResponse.json({ error: "Invalid webhook payload" }, { status: 400 });
    }

    if (!type.startsWith("email.")) {
      return NextResponse.json({ received: true, skipped: true });
    }

    // ── Handle inbound/received emails ──
    if (type === "email.received") {
      const emailId = data.email_id;
      if (emailId) {
        // Check if already exists
        const { data: existing } = await supabase
          .from("inbound_emails")
          .select("id")
          .eq("message_id", emailId)
          .maybeSingle();

        let storedThreadId: string | null = null;
        let inReplyTo: string | null = null;
        if (!existing) {
          // Fetch full email details from Resend
          try {
            const fetched = await resend.emails.receiving.get(emailId);
            if (fetched.data) {
              const e = fetched.data;
              // Try to stitch into an existing thread via in_reply_to /
              // references headers. Resend exposes these on the email
              // object. If we find a matching outbound, reuse its
              // thread_id so reply-counts and inbox views align.
              const headers = (e as unknown as { headers?: Record<string, string> }).headers ?? {};
              inReplyTo = headers["in-reply-to"] || headers["In-Reply-To"] || (e as unknown as { in_reply_to?: string }).in_reply_to || null;
              if (inReplyTo) {
                const { data: outbound } = await supabase
                  .from("emails")
                  .select("thread_id")
                  .eq("message_id", inReplyTo.replace(/[<>]/g, ""))
                  .maybeSingle();
                if (outbound?.thread_id) storedThreadId = outbound.thread_id as string;
              }
              // Fallback stitch: emails.message_id was historically never
              // populated by any send path (bug found by ultrareview), so
              // the in_reply_to lookup misses every time. Match by
              // sender↔recipient pair instead — if this inbound's `from`
              // is someone we've sent to from this `to` address, take
              // their most recent thread. Loses precision when one rep
              // sent multiple unrelated threads to the same person, but
              // that's rare in cold-outreach and beats creating a fresh
              // thread on every reply (which silently breaks
              // pipeline_leads.status=replied flipping below).
              if (!storedThreadId) {
                const inboundFrom = String(e.from ?? "").match(/[\w.+-]+@[\w.-]+/)?.[0]?.toLowerCase();
                const inboundTo = (Array.isArray(e.to) ? e.to[0] : e.to ?? "").toString().match(/[\w.+-]+@[\w.-]+/)?.[0]?.toLowerCase();
                if (inboundFrom && inboundTo) {
                  const { data: matched } = await supabase
                    .from("emails")
                    .select("thread_id, created_at")
                    .ilike("to", `%${inboundFrom}%`)
                    .ilike("from", `%${inboundTo}%`)
                    .not("thread_id", "is", null)
                    .order("created_at", { ascending: false })
                    .limit(1);
                  if (matched?.[0]?.thread_id) storedThreadId = matched[0].thread_id as string;
                }
              }
              if (!storedThreadId) {
                storedThreadId = `thread_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
              }

              const toField = Array.isArray(e.to) ? e.to.join(", ") : (e.to || "");
              // Resolve which rep this inbound belongs to. Recipient
              // address wins; thread_id is fallback. Without this, every
              // new inbound landed with rep_id=NULL and Chenyu/Ethan's
              // inbox views were empty.
              const repId = await resolveInboundRepId(toField, storedThreadId);
              await supabase.from("inbound_emails").insert({
                from: e.from,
                to: toField,
                subject: e.subject || "(no subject)",
                html: e.html || null,
                text: e.text || null,
                message_id: emailId,
                in_reply_to: inReplyTo,
                thread_id: storedThreadId,
                rep_id: repId,
                created_at: e.created_at,
              });
            }
          } catch {
            // Fallback: store with available webhook data
            storedThreadId = `thread_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
            const toField = Array.isArray(data.to) ? data.to.join(", ") : (data.to || "");
            const repId = await resolveInboundRepId(toField, storedThreadId);
            await supabase.from("inbound_emails").insert({
              from: data.from || "unknown",
              to: toField,
              subject: data.subject || "(no subject)",
              message_id: emailId,
              thread_id: storedThreadId,
              rep_id: repId,
            });
          }

          // Flip the originating pipeline_lead to status='replied'.
          // Same logic as /api/inbound but tied to the resolved
          // thread_id so we don't accidentally flip an unrelated lead.
          // Without this, /api/metrics/me showed 0 replies even though
          // 21 inbounds existed — the production reply path is
          // /api/webhook (Resend), not /api/inbound.
          if (storedThreadId) {
            try {
              const { data: outbound } = await supabase
                .from("emails")
                .select("to")
                .eq("thread_id", storedThreadId)
                .order("created_at", { ascending: true })
                .limit(1);
              const recipientRaw = outbound?.[0]?.to as string | undefined;
              const recipient = recipientRaw
                ? (recipientRaw.startsWith("[") ? (() => { try { return JSON.parse(recipientRaw)[0]; } catch { return recipientRaw; } })() : recipientRaw).split(",")[0].trim().toLowerCase()
                : "";
              if (recipient) {
                await supabase
                  .from("pipeline_leads")
                  .update({ status: "replied" })
                  .eq("thread_id", storedThreadId)
                  .ilike("author_email", recipient)
                  .eq("status", "sent");
              }
            } catch (err) {
              console.warn("webhook email.received: lead flip to 'replied' failed", err);
            }
          }
        }
      }

      // Store webhook event (no email_id FK for inbound)
      await supabase.from("webhook_events").insert({
        type,
        payload: rawBody,
      });

      return NextResponse.json({ received: true });
    }

    // ── Handle outbound email events ──
    const resendEmailId = data.email_id;
    let emailId: string | null = null;

    if (resendEmailId) {
      const { data: email } = await supabase
        .from("emails")
        .select("id")
        .eq("resend_id", resendEmailId)
        .single();

      if (email) {
        emailId = email.id;
      } else {
        // Email not in DB — fetch from Resend and create it
        const fetched = await resend.emails.get(resendEmailId);
        if (fetched.data) {
          const e = fetched.data;
          const threadId = `thread_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
          const status = mapResendEventToStatus(type);

          const { data: inserted } = await supabase
            .from("emails")
            .insert({
              from: e.from,
              to: Array.isArray(e.to) ? e.to.join(", ") : (e.to || ""),
              subject: e.subject || "(no subject)",
              html: e.html || "",
              text: e.text || null,
              resend_id: e.id,
              status,
              created_at: e.created_at,
              updated_at: new Date().toISOString(),
              thread_id: threadId,
            })
            .select("id")
            .single();

          emailId = inserted?.id || null;
        }
      }
    }

    // Store webhook event
    await supabase.from("webhook_events").insert({
      email_id: emailId,
      type,
      payload: rawBody,
    });

    // Update email status
    if (emailId) {
      const newStatus = mapResendEventToStatus(type);
      if (newStatus) {
        await supabase
          .from("emails")
          .update({ status: newStatus, updated_at: new Date().toISOString() })
          .eq("id", emailId);

        // Propagate delivery-status signals to pipeline_leads so the
        // lead-level view stays in sync with the email-level truth.
        // Previously the webhook only touched `emails`, leaving
        // `pipeline_leads.status` stuck at 'sent' regardless of
        // bounce/complaint — sales couldn't tell which of their
        // "sent" leads actually landed. We only REGRESS status for
        // bad outcomes (bounced / complained → set a dedicated
        // column so counts stay honest without overwriting 'replied'
        // if a reply happens to arrive first).
        if (newStatus === "bounced" || newStatus === "complained") {
          // Locate the lead via the shared thread_id on emails row.
          const { data: emailRow } = await supabase
            .from("emails")
            .select("thread_id")
            .eq("id", emailId)
            .maybeSingle();
          const threadId = emailRow?.thread_id as string | null;
          if (threadId) {
            await supabase
              .from("pipeline_leads")
              .update({
                bounced_at: newStatus === "bounced" ? new Date().toISOString() : null,
                complained_at: newStatus === "complained" ? new Date().toISOString() : null,
              })
              .eq("thread_id", threadId);
          }
        }
      }
    }

    return NextResponse.json({ received: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Webhook processing failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
