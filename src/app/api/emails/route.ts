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

  // When search is active we fetch a wider candidate pool and re-rank
  // in JS by where the match landed (recipient > subject > greeting line >
  // body). Without this, broad terms like "li" returned 1374 rows ordered
  // purely by created_at and the user couldn't find the right thread.
  // Browse-mode (no search) keeps the original recency order.
  const RANK_POOL = 200;

  function buildQuery(countOnly: boolean) {
    let q = countOnly
      ? supabase.from("emails").select("*", { count: "exact", head: true })
      : supabase
          .from("emails")
          .select("*")
          .order("created_at", { ascending: false })
          .range(0, search ? RANK_POOL - 1 : offset + limit - 1);

    if (status) q = q.eq("status", status);
    if (senderEmail) q = q.ilike("from", `%${senderEmail}%`);
    if (search) {
      // Postgrest .or() requires '*' wildcards (chained .ilike uses '%').
      // Strip chars that break the .or() comma-parser.
      const safe = search.replace(/[,()*"]/g, " ").trim();
      if (safe.length > 0) {
        const needle = `*${safe}*`;
        q = q.or(
          [
            `to.ilike.${needle}`,
            `subject.ilike.${needle}`,
            `text.ilike.${needle}`,
            `html.ilike.${needle}`,
          ].join(","),
        );
      }
    }
    return q;
  }

  const [{ data }, { count }] = await Promise.all([
    buildQuery(false),
    buildQuery(true),
  ]);
  const emails: Record<string, unknown>[] = data || [];
  const total = count || 0;

  type EmailLite = {
    id: unknown; from: unknown; to: unknown; subject: unknown;
    html: unknown; text: unknown; status: unknown;
    resendId: unknown; createdAt: unknown; threadId: unknown;
  };
  let mapped: EmailLite[] = emails.map((e) => ({
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
  // theirs, even if the ilike filter above somehow missed.
  if (senderEmail) {
    const needle = senderEmail.toLowerCase();
    mapped = mapped.filter((e) => typeof e.from === "string" && e.from.toLowerCase().includes(needle));
  }

  // Re-rank when searching. Score each row by where the term landed:
  //   recipient (to)        100
  //   subject               50
  //   first 200 chars text  30  (this is where "Shuicheng你好" greetings sit)
  //   anywhere in body      5
  // Multiplied by a recency factor in [1, 2] so newer wins on ties.
  // Without re-ranking, "li" returns rows sorted purely by created_at
  // and the actual recipient with name "Li" can be page 28.
  if (search) {
    const term = search.toLowerCase().trim();
    const oldestMs = Math.min(
      ...mapped.map((e) => (typeof e.createdAt === "string" ? new Date(e.createdAt).getTime() : 0)).filter((n) => n > 0),
      Date.now(),
    );
    const span = Math.max(Date.now() - oldestMs, 1);
    const score = (e: EmailLite): number => {
      let s = 0;
      const to = typeof e.to === "string" ? e.to.toLowerCase() : "";
      const subj = typeof e.subject === "string" ? e.subject.toLowerCase() : "";
      const text = typeof e.text === "string" ? e.text.toLowerCase() : "";
      const html = typeof e.html === "string" ? e.html.toLowerCase() : "";
      if (to.includes(term)) s += 100;
      if (subj.includes(term)) s += 50;
      const head = text.slice(0, 200) || html.replace(/<[^>]+>/g, "").slice(0, 200);
      if (head.includes(term)) s += 30;
      if (text.includes(term) || html.includes(term)) s += 5;
      const t = typeof e.createdAt === "string" ? new Date(e.createdAt).getTime() : 0;
      const recency = t > 0 ? 1 + (t - oldestMs) / span : 1;
      return s * recency;
    };
    mapped.sort((a, b) => score(b) - score(a));
    mapped = mapped.slice(offset, offset + limit);
  }

  return NextResponse.json({
    emails: mapped,
    total: senderEmail ? mapped.length : (total || 0),
    page,
    limit,
    ranked: !!search,
  });
}
