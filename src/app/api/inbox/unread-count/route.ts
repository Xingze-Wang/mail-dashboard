import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";
import { getRep } from "@/lib/assignment";

export async function GET(req: NextRequest) {
  // Per-sales scoping: count only unread replies in threads where this
  // rep was the original sender. The two-step lookup is necessary
  // because `inbound_emails` has no direct rep_id — we find the rep's
  // threads via the `emails` (outbound) table, then count inbounds that
  // belong to those threads.
  const session = await requireSession(req);
  const isPrivileged = session?.role === "admin" || session?.role === "senior";

  if (!isPrivileged && session?.repId) {
    const rep = await getRep(session.repId);
    if (!rep) return NextResponse.json({ count: 0 });
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
    if (error) return NextResponse.json({ count: 0, error: error.message }, { status: 500 });
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
