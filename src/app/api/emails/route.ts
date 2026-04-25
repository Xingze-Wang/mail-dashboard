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
    if (search) {
      // Search across recipient, subject, AND body content (text + html)
      // in one OR query. Previously the route only hit `to` then fell
      // back to `subject` if `to` was empty — which silently shadowed
      // subject matches whenever any recipient happened to match, and
      // never searched body content at all. Postgrest .or() escapes
      // commas inside the value if we wrap with quotes; we strip any
      // commas from the term to keep the syntax simple.
      const safe = search.replace(/[,()]/g, " ").trim();
      const needle = `%${safe}%`;
      q = q.or(
        [
          `to.ilike.${needle}`,
          `subject.ilike.${needle}`,
          `text.ilike.${needle}`,
          `html.ilike.${needle}`,
        ].join(","),
      );
    }
    return q;
  }

  const [{ data }, { count }] = await Promise.all([
    buildQuery(false),
    buildQuery(true),
  ]);
  const emails: Record<string, unknown>[] = data || [];
  const total = count || 0;

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
