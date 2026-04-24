import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * POST /api/brief/wechat
 *
 * Mark that someone added us on WeChat (= conversion event).
 * Body: { query, arxiv_id?, lead_id?, notes? }
 */
export async function POST(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { query, arxiv_id, lead_id, notes } = body;

  if (!query) {
    return NextResponse.json({ error: "query required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("brief_lookups")
    .insert({
      query,
      arxiv_id: arxiv_id || null,
      lead_id: lead_id || null,
      added_wechat: true,
      wechat_at: new Date().toISOString(),
      notes: notes || null,
      // Attribute the conversion to the session's rep. Brief search is
      // deliberately cross-rep (any rep can look up anyone for WeChat
      // follow-up), but admin still needs to audit who marked which
      // lead as "added on WeChat". Without rep_id these were orphan
      // rows.
      marked_by_rep_id: session.repId,
      marked_by_email: session.email,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Do NOT touch pipeline_leads.status here. "Added on WeChat" is a
  // separate conversion event tracked entirely in brief_lookups. We used to
  // set status='replied' which inflated the per-rep "Replies" stat — Chenyu
  // showed 1 reply when the recipient had only added on WeChat, never
  // emailed back. The Replies metric should reflect actual inbound email
  // replies, not WeChat conversions.

  return NextResponse.json({ ok: true, id: data.id });
}

/**
 * GET /api/brief/wechat?arxiv_id=xxx or ?lead_id=xxx
 *
 * Check if someone already marked this as "added on WeChat"
 */
export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const arxiv_id = searchParams.get("arxiv_id");
  const lead_id = searchParams.get("lead_id");

  if (!arxiv_id && !lead_id) {
    return NextResponse.json({ error: "arxiv_id or lead_id required" }, { status: 400 });
  }

  let query = supabase
    .from("brief_lookups")
    .select("*")
    .eq("added_wechat", true)
    .order("created_at", { ascending: false })
    .limit(1);

  if (arxiv_id) query = query.eq("arxiv_id", arxiv_id);
  if (lead_id) query = query.eq("lead_id", lead_id);

  const { data } = await query;
  const record = data?.[0] || null;

  return NextResponse.json({ addedWechat: !!record, record });
}
