import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { resend } from "@/lib/resend";
import { requireSession } from "@/lib/auth-helpers";
import { getRep } from "@/lib/assignment";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const { data: email } = await supabase
    .from("emails")
    .select("*")
    .eq("id", id)
    .single();

  if (!email) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Per-rep scoping: a sales user can only see emails they themselves
  // sent. Admin + senior see everything (they triage across the team).
  // We compare the row's `from` string against the acting rep's
  // sender_email — that's the same contract used by /api/emails list
  // scoping, so both endpoints agree on what "yours" means.
  const session = await requireSession(req);
  const isPrivileged = session?.role === "admin" || session?.role === "senior";
  if (!isPrivileged && session?.repId) {
    const rep = await getRep(session.repId);
    const fromStr = typeof email.from === "string" ? email.from.toLowerCase() : "";
    const mine = rep?.sender_email
      ? fromStr.includes(rep.sender_email.toLowerCase())
      : false;
    if (!mine) {
      // Return 404 (not 403) so we don't leak which IDs exist in the DB.
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
