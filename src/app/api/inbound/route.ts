import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";

export async function POST(req: NextRequest) {
  try {
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

  const [{ data: emails }, { count: total }] = await Promise.all([
    supabase
      .from("inbound_emails")
      .select()
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1),
    supabase
      .from("inbound_emails")
      .select("*", { count: "exact", head: true }),
  ]);

  return NextResponse.json({ emails: emails || [], total: total || 0, page, limit });
}
