import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { resend } from "@/lib/resend";
import { requireSession } from "@/lib/auth-helpers";
import { getRep } from "@/lib/assignment";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Auth required up front. Previously a null session fell through the
  // ownership check entirely and returned the email body to any caller.
  const session = await requireSession(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const { data: email } = await supabase
    .from("emails")
    .select("*")
    .eq("id", id)
    .single();

  if (!email) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Per-rep scoping: sales see only their own outbound. Admin + senior
  // unrestricted.
  const isPrivileged = session.role === "admin" || session.role === "senior";
  if (!isPrivileged) {
    const rep = await getRep(session.repId);
    const fromStr = typeof email.from === "string" ? email.from.toLowerCase() : "";
    const mine = rep?.sender_email
      ? fromStr.includes(rep.sender_email.toLowerCase())
      : false;
    if (!mine) {
      // 404 (not 403) so we don't leak which IDs exist.
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
  }

  // If we have no content but have a resend_id, fetch from Resend
  if ((!email.html || email.html === "") && email.resend_id) {
    try {
      const fetched = await resend.emails.get(email.resend_id);
      if (fetched.data) {
        const html = fetched.data.html || "";
        const text = fetched.data.text || null;

        // Cache it in the DB for next time
        if (html || text) {
          await supabase
            .from("emails")
            .update({ html, text })
            .eq("id", id);
        }

        return NextResponse.json({
          id: email.id,
          from: email.from,
          to: email.to,
          subject: email.subject,
          html,
          text,
          status: email.status,
          resendId: email.resend_id,
          createdAt: email.created_at,
          threadId: email.thread_id,
        });
      }
    } catch {
      // Fall through to return what we have
    }
  }

  return NextResponse.json({
    id: email.id,
    from: email.from,
    to: email.to,
    subject: email.subject,
    html: email.html,
    text: email.text,
    status: email.status,
    resendId: email.resend_id,
    createdAt: email.created_at,
    threadId: email.thread_id,
  });
}
