import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "50");
  const status = searchParams.get("status");
  const search = searchParams.get("search")?.trim();
  const offset = (page - 1) * limit;

  let query = supabase
    .from("emails")
    .select("*")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  let countQuery = supabase
    .from("emails")
    .select("*", { count: "exact", head: true });

  if (status) {
    query = query.eq("status", status);
    countQuery = countQuery.eq("status", status);
  }

  if (search) {
    // Search across to and subject fields
    const filter = `to.ilike.%${search}%,subject.ilike.%${search}%`;
    query = query.or(filter);
    countQuery = countQuery.or(filter);
  }

  const [{ data: emails }, { count: total }] = await Promise.all([query, countQuery]);

  const mapped = (emails || []).map((e) => ({
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
