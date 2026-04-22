import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";
import { getRep } from "@/lib/assignment";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "50");
  const status = searchParams.get("status");
  const search = searchParams.get("search")?.trim();
  const offset = (page - 1) * limit;

  // Auth required + per-sales scoping. Prior logic returned every email
  // when the session was missing or the rep row lookup failed — an
  // unauthenticated browser/curl would receive the entire team's
  // outbound history. Now we require a session AND a resolvable rep
  // row for non-privileged users; if either is missing the list is
  // empty (fail-closed).
  const session = await requireSession(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const isPrivileged = session.role === "admin";
  let senderEmail: string | null = null;
  if (!isPrivileged) {
    const rep = await getRep(session.repId);
    if (!rep?.sender_email) {
      return NextResponse.json({ emails: [], total: 0, page, limit });
    }
    senderEmail = rep.sender_email;
  }

  function buildQuery(countOnly: boolean) {
    let q = countOnly
      ? supabase.from("emails").select("*", { count: "exact", head: true })
      : supabase
          .from("emails")
          .select("*")
          .order("created_at", { ascending: false })
          .range(offset, offset + limit - 1);

    if (status) q = q.eq("status", status);
    if (senderEmail) q = q.ilike("from", `%${senderEmail}%`);
    return q;
  }

  let emails: Record<string, unknown>[] = [];
  let total = 0;

  if (search) {
    // Priority 1: search by recipient email (to field)
    let q = buildQuery(false).ilike("to", `%${search}%`);
    let cq = buildQuery(true).ilike("to", `%${search}%`);
    const [{ data: toResults }, { count: toCount }] = await Promise.all([q, cq]);

    if (toResults && toResults.length > 0) {
      emails = toResults;
      total = toCount || 0;
    } else {
      // Priority 2: fall back to subject search
      q = buildQuery(false).ilike("subject", `%${search}%`);
      cq = buildQuery(true).ilike("subject", `%${search}%`);
      const [{ data: subResults }, { count: subCount }] = await Promise.all([q, cq]);
      emails = subResults || [];
      total = subCount || 0;
    }
  } else {
    const [{ data }, { count }] = await Promise.all([
      buildQuery(false),
      buildQuery(true),
    ]);
    emails = data || [];
    total = count || 0;
  }

  let mapped = emails.map((e) => ({
    id: e.id,
    from: e.from,
    to: e.to,
    subject: e.subject,
    html: e.html,
    text: e.text,
    status: e.status,
    resendId: e.resend_id,
    createdAt: e.created_at,
    threadId: e.thread_id,
  }));

  // Defense in depth: non-admin must never see an email that isn't
  // theirs, even if the ilike filter above somehow missed. This is a
  // paranoid catch-net — the query should already be scoped.
  if (senderEmail) {
    const needle = senderEmail.toLowerCase();
    mapped = mapped.filter((e) => typeof e.from === "string" && e.from.toLowerCase().includes(needle));
  }

  return NextResponse.json({ emails: mapped, total: senderEmail ? mapped.length : (total || 0), page, limit });
}
