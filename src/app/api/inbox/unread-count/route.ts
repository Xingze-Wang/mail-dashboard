import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";
import { getRep } from "@/lib/assignment";
import { countReplies, getThreadIdsForRep } from "@/lib/canonical-counts";

export async function GET(req: NextRequest) {
  // Auth required + per-sales scoping. Fail-closed: no session → 0;
  // non-privileged with no rep → 0. Previously unauthenticated callers
  // got the global unread count.
  const session = await requireSession(req);
  if (!session) {
    return NextResponse.json({ count: 0 });
  }
  const isPrivileged = session.role === "admin";

  if (!isPrivileged) {
    const rep = await getRep(session.repId);
    if (!rep?.sender_email) return NextResponse.json({ count: 0 });
    // Same scope shape as /api/inbound GET: `rep_id = self` OR
    // `thread_id IN my-sent-threads`. Previously this route only
    // checked thread_id and undercounted any correctly-stamped reply
    // (e.g. rep_id matched via the resolver's exact-address path) whose
    // outbound chain didn't carry a matching thread_id. The badge now
    // can't disagree with the list view.
    const threadIds = await getThreadIdsForRep(session.repId, rep.sender_email);
    const { unread } = await countReplies({ repId: session.repId, threadIds, isRead: false });
    return NextResponse.json({ count: unread });
  }

  // Admin / senior: whole-team unread.
  const { unread } = await countReplies({ isRead: false });
  return NextResponse.json({ count: unread });
}
