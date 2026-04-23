import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";
import { getRep } from "@/lib/assignment";

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
    // Thread ids this rep owns.
    const { data: outbound } = await supabase
      .from("emails")
      .select("thread_id")
      .ilike("from", `%${rep.sender_email}%`)
      .not("thread_id", "is", null);
    const threadIds = (outbound ?? [])
      .map((r) => r.thread_id as string | null)
      .filter((t): t is string => !!t);
    if (threadIds.length === 0) return NextResponse.json({ count: 0 });

    const { count, error } = await supabase
      .from("inbound_emails")
      .select("*", { count: "exact", head: true })
      .eq("is_read", false)
      .in("thread_id", threadIds);
    if (error) {
      console.error("inbox/unread-count query error — returning 0", error);
      return NextResponse.json({ count: 0 });
    }
    return NextResponse.json({ count: count ?? 0 });
  }

  // Admin / senior / unauthenticated: unchanged, whole-team count.
  const { count, error } = await supabase
    .from("inbound_emails")
    .select("*", { count: "exact", head: true })
    .eq("is_read", false);

  if (error) return NextResponse.json({ count: 0, error: error.message }, { status: 500 });
  return NextResponse.json({ count: count ?? 0 });
}
