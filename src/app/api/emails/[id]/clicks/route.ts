import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";
import { getRep } from "@/lib/assignment";

export const dynamic = "force-dynamic";

/**
 * GET /api/emails/[id]/clicks
 *
 * Returns every click (and other notable lifecycle events) for a single
 * outbound email, sourced from webhook_events. The Resend "get email"
 * API only returns last_event, so to know that a recipient clicked
 * three times — once on the WeChat link, once on the paper, then again
 * the next day — we have to read the event log.
 *
 * Each row in webhook_events stores the raw Svix payload as text. We
 * parse and project the fields most useful for display:
 *   - timestamp (when Resend recorded it)
 *   - link (clicked URL — null for non-click events)
 *   - userAgent / ipAddress (helpful for de-duping a single human
 *     clicking through preview vs. real)
 *
 * Scoping mirrors /api/emails/[id]: sales see only their own outbound,
 * admin sees all.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  const { data: email } = await supabase
    .from("emails")
    .select("id, from, resend_id")
    .eq("id", id)
    .single();
  if (!email) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (session.role !== "admin") {
    const rep = await getRep(session.repId);
    const fromStr = typeof email.from === "string" ? email.from.toLowerCase() : "";
    const mine = rep?.sender_email ? fromStr.includes(rep.sender_email.toLowerCase()) : false;
    if (!mine) return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { data: events, error } = await supabase
    .from("webhook_events")
    .select("type, payload, created_at")
    .eq("email_id", email.id)
    .order("created_at", { ascending: true });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const parsed = (events ?? []).map((row) => {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(row.payload as string);
    } catch {
      // Old rows or partial events — leave fields null.
    }
    const data = (payload.data ?? {}) as Record<string, unknown>;
    const click = (data.click ?? {}) as Record<string, unknown>;
    return {
      type: row.type,
      occurredAt: row.created_at,
      // Resend nests click metadata under data.click for email.clicked.
      // For non-click events these fields stay null and the row still
      // documents that the event happened (delivered, opened, bounced).
      link: (click.link as string) ?? null,
      userAgent: (click.userAgent as string) ?? null,
      ipAddress: (click.ipAddress as string) ?? null,
      timestamp: (click.timestamp as string) ?? (data.created_at as string) ?? null,
    };
  });

  const clickEvents = parsed.filter((e) => e.type === "email.clicked");
  const distinctLinks = new Set(clickEvents.map((c) => c.link).filter(Boolean));

  // Fallback: if webhook_events has nothing for this email but Resend
  // has actually been recording status, synthesize a minimal timeline
  // from emails.status + created_at. Better than rendering "no real-
  // time tracking" when the rep can SEE click rates working in the
  // status badge. The synthesized events have _synthesized=true so the
  // UI can render them with a different style if desired.
  if (parsed.length === 0) {
    const { data: full } = await supabase
      .from("emails")
      .select("status, created_at, updated_at")
      .eq("id", email.id)
      .maybeSingle();
    if (full?.status) {
      const STATUS_RANK: Record<string, number> = {
        queued: 0, sent: 1, delivered: 2, opened: 3, clicked: 4, bounced: 5, complained: 5,
      };
      const reached = Object.entries(STATUS_RANK)
        .filter(([, rank]) => rank <= (STATUS_RANK[full.status] ?? -1))
        .filter(([s]) => s !== "queued") // queued is implicit
        .map(([s]) => s);
      const synthesized = reached.map((status, i) => ({
        type: `email.${status}`,
        occurredAt: i === reached.length - 1 ? (full.updated_at ?? full.created_at) : full.created_at,
        link: null,
        userAgent: null,
        ipAddress: null,
        timestamp: i === reached.length - 1 ? (full.updated_at ?? full.created_at) : full.created_at,
        _synthesized: true,
      }));
      return NextResponse.json({
        emailId: email.id,
        resendId: email.resend_id,
        eventCount: synthesized.length,
        clickCount: synthesized.filter((e) => e.type === "email.clicked").length,
        distinctLinkCount: 0,
        events: synthesized,
        _source: "synthesized_from_emails_status",
      });
    }
  }

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
