import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";
import { getRep } from "@/lib/assignment";

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
    const secret = process.env.INBOUND_SECRET;
    if (secret) {
      const auth = req.headers.get("authorization") || "";
      const header = req.headers.get("x-inbound-secret") || "";
      if (auth !== `Bearer ${secret}` && header !== secret) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }
    const body = await req.json();
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

    const { data: inbound, error } = await supabase
      .from("inbound_emails")
      .insert({
        from: from || "unknown",
        to: Array.isArray(to) ? to.join(", ") : (to || ""),
        subject: subject || "(no subject)",
        html: html || null,
        text: text || null,
        message_id: message_id || null,
        in_reply_to: in_reply_to || null,
        references: references || null,
        thread_id: threadId,
        headers: headers ? JSON.stringify(headers) : null,
      })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
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
  let threadIds: string[] | null = null;
  if (!isPrivileged) {
    const rep = await getRep(session.repId);
    if (!rep?.sender_email) {
      return NextResponse.json({ emails: [], total: 0, page, limit });
    }
    const { data: outbound } = await supabase
      .from("emails")
      .select("thread_id")
      .ilike("from", `%${rep.sender_email}%`)
      .not("thread_id", "is", null);
    threadIds = (outbound ?? [])
      .map((r) => r.thread_id as string | null)
      .filter((t): t is string => !!t);
    if (threadIds.length === 0) return NextResponse.json({ emails: [], total: 0, page, limit });
  }

  let listQuery = supabase
    .from("inbound_emails")
    .select()
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  let countQuery = supabase
    .from("inbound_emails")
    .select("*", { count: "exact", head: true });
  if (threadIds) {
    listQuery = listQuery.in("thread_id", threadIds);
    countQuery = countQuery.in("thread_id", threadIds);
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

  return NextResponse.json({ emails: mapped, total: total || 0, page, limit });
}
