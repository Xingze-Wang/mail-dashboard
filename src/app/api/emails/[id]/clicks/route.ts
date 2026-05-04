import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { resend } from "@/lib/resend";
import { requireSession } from "@/lib/auth-helpers";
import { getRep } from "@/lib/assignment";

export const dynamic = "force-dynamic";

const STATUS_RANK: Record<string, number> = {
  queued: 0, sent: 1, delivered: 2, opened: 3, clicked: 4, bounced: 2, complained: 2,
};

// Map Resend's `last_event` (unprefixed) to a synthetic event timeline.
// Resend's get-email API only returns last_event — there are no per-event
// timestamps. We synthesize a timeline from status rank so the UI shows
// at minimum "Sent → Delivered → Clicked" chips for every email whose
// status is known, without needing webhook_events rows.
function synthesizeFromStatus(status: string, sentAt: string, updatedAt: string) {
  const rank = STATUS_RANK[status] ?? -1;
  if (rank < 1) return []; // queued or unknown — nothing to show

  const events: Array<{ type: string; occurredAt: string; link: null; userAgent: null; ipAddress: null; timestamp: string; _synthesized: true }> = [];

  // Always show sent
  events.push({ type: "email.sent", occurredAt: sentAt, link: null, userAgent: null, ipAddress: null, timestamp: sentAt, _synthesized: true });

  if (status === "bounced" || status === "complained") {
    events.push({ type: `email.${status}`, occurredAt: updatedAt, link: null, userAgent: null, ipAddress: null, timestamp: updatedAt, _synthesized: true });
    return events;
  }

  if (rank >= 2) events.push({ type: "email.delivered", occurredAt: updatedAt, link: null, userAgent: null, ipAddress: null, timestamp: updatedAt, _synthesized: true });
  if (rank >= 3) events.push({ type: "email.opened",    occurredAt: updatedAt, link: null, userAgent: null, ipAddress: null, timestamp: updatedAt, _synthesized: true });
  if (rank >= 4) events.push({ type: "email.clicked",   occurredAt: updatedAt, link: null, userAgent: null, ipAddress: null, timestamp: updatedAt, _synthesized: true });

  return events;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  const { data: email } = await supabase
    .from("emails")
    .select("id, from, resend_id, status, created_at, updated_at")
    .eq("id", id)
    .single();
  if (!email) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (session.role !== "admin") {
    const rep = await getRep(session.repId);
    const fromStr = typeof email.from === "string" ? email.from.toLowerCase() : "";
    const mine = rep?.sender_email ? fromStr.includes(rep.sender_email.toLowerCase()) : false;
    if (!mine) return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // 1. Try webhook_events first (populated once webhook secret is fixed).
  const { data: webhookRows } = await supabase
    .from("webhook_events")
    .select("type, payload, created_at")
    .eq("email_id", email.id)
    .order("created_at", { ascending: true });

  if (webhookRows && webhookRows.length > 0) {
    const parsed = webhookRows.map((row) => {
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(row.payload as string); } catch { /* leave empty */ }
      const data = (payload.data ?? {}) as Record<string, unknown>;
      const click = (data.click ?? {}) as Record<string, unknown>;
      return {
        type: row.type,
        occurredAt: row.created_at,
        link: (click.link as string) ?? null,
        userAgent: (click.userAgent as string) ?? null,
        ipAddress: (click.ipAddress as string) ?? null,
        timestamp: (click.timestamp as string) ?? (data.created_at as string) ?? row.created_at,
      };
    });
    const clickEvents = parsed.filter((e) => e.type === "email.clicked");
    const distinctLinks = new Set(clickEvents.map((c) => c.link).filter(Boolean));
    return NextResponse.json({
      emailId: email.id,
      resendId: email.resend_id,
      eventCount: parsed.length,
      clickCount: clickEvents.length,
      distinctLinkCount: distinctLinks.size,
      events: parsed,
      _source: "webhook_events",
    });
  }

  // 2. Try Resend API directly — get the authoritative last_event + timestamps.
  //    resend.emails.get() returns created_at and last_event. No per-event log
  //    exists in Resend's API, but at least we get real send timestamp.
  if (email.resend_id) {
    try {
      const fetched = await resend.emails.get(email.resend_id as string);
      if (fetched.data) {
        const re = fetched.data;
        const sentAt = (re.created_at as string) ?? (email.created_at as string);
        const status = (re.last_event as string) ?? (email.status as string) ?? "sent";
        const updatedAt = (email.updated_at as string) ?? sentAt;
        const events = synthesizeFromStatus(status, sentAt, updatedAt);
        const clickEvents = events.filter((e) => e.type === "email.clicked");
        return NextResponse.json({
          emailId: email.id,
          resendId: email.resend_id,
          eventCount: events.length,
          clickCount: clickEvents.length,
          distinctLinkCount: 0,
          events,
          _source: "resend_api",
        });
      }
    } catch {
      // Fall through to DB fallback
    }
  }

  // 3. Final fallback: synthesize from emails.status already in our DB.
  const status = (email.status as string) ?? "";
  const sentAt = (email.created_at as string) ?? new Date().toISOString();
  const updatedAt = (email.updated_at as string) ?? sentAt;
  const events = synthesizeFromStatus(status, sentAt, updatedAt);
  const clickEvents = events.filter((e) => e.type === "email.clicked");

  return NextResponse.json({
    emailId: email.id,
    resendId: email.resend_id,
    eventCount: events.length,
    clickCount: clickEvents.length,
    distinctLinkCount: 0,
    events,
    _source: "db_status",
  });
}
