import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";
import { getRep } from "@/lib/assignment";

export const dynamic = "force-dynamic";

/**
 * GET /api/inbox/thread/[id]
 *
 * Returns every message on a thread — outbound (emails) + inbound
 * (inbound_emails) — merged and sorted by created_at. Powers the
 * inbox thread view, which previously showed only the selected
 * inbound and hid any replies sales sent. When a rep replied, their
 * own reply vanished from the view even though the DB had it.
 *
 * Scoping: non-admin must own the thread — i.e. there must be at
 * least one outbound row on this thread_id that matches this rep's
 * rep_id (migration 014) or sender_email (fallback for rows predating
 * rep_id). 404 on miss to avoid exposing that other threads exist.
 *
 * `id` in the route is the THREAD id (text), not the email row id.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id: threadId } = await params;
  if (!threadId) return NextResponse.json({ error: "threadId required" }, { status: 400 });

  const isPrivileged = session.role === "admin";

  // Ownership gate for non-admin. We try canonical rep_id first
  // (migration 014); if the thread has no rep_id-stamped rows yet
  // (historical data), fall back to the sender_email proxy filter
  // that the rest of the inbox uses.
  if (!isPrivileged) {
    const { data: owned } = await supabase
      .from("emails")
      .select("id")
      .eq("thread_id", threadId)
      .eq("rep_id", session.repId)
      .limit(1);
    if (!owned || owned.length === 0) {
      const rep = await getRep(session.repId);
      const senderEmail = rep?.sender_email;
      if (!senderEmail) return NextResponse.json({ error: "Thread not found" }, { status: 404 });
      const { data: ownedLegacy } = await supabase
        .from("emails")
        .select("id")
        .eq("thread_id", threadId)
        .ilike("from", `%${senderEmail}%`)
        .limit(1);
      if (!ownedLegacy || ownedLegacy.length === 0) {
        return NextResponse.json({ error: "Thread not found" }, { status: 404 });
      }
    }
  }

  const [outboundR, inboundR] = await Promise.all([
    supabase
      .from("emails")
      .select("id, from, to, subject, html, text, status, created_at, in_reply_to, references")
      .eq("thread_id", threadId)
      .order("created_at", { ascending: true }),
    supabase
      .from("inbound_emails")
      .select("id, from, to, subject, html, text, created_at, in_reply_to, references")
      .eq("thread_id", threadId)
      .order("created_at", { ascending: true }),
  ]);

  const outbound = (outboundR.data ?? []).map((r) => ({
    ...r,
    direction: "outbound" as const,
    is_read: true,
  }));
  const inbound = (inboundR.data ?? []).map((r) => ({
    ...r,
    direction: "inbound" as const,
    status: null as string | null,
    is_read: true,
  }));
  const merged = [...outbound, ...inbound].sort((a, b) => {
    const ta = a.created_at ? new Date(a.created_at as string).getTime() : 0;
    const tb = b.created_at ? new Date(b.created_at as string).getTime() : 0;
    return ta - tb;
  });

  return NextResponse.json({ threadId, messages: merged });
}
