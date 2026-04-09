import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "50");
  const status = searchParams.get("status");
  const search = searchParams.get("search")?.trim();
  const offset = (page - 1) * limit;

  function buildQuery(countOnly: boolean) {
    let q = countOnly
      ? supabase.from("emails").select("*", { count: "exact", head: true })
      : supabase
          .from("emails")
          .select("*")
          .order("created_at", { ascending: false })
          .range(offset, offset + limit - 1);

    if (status) q = q.eq("status", status);
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

  const mapped = emails.map((e) => ({
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

  return NextResponse.json({ emails: mapped, total: total || 0, page, limit });
}
