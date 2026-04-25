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

  // UPSERT on (lead_id) where added_wechat=true — migration 016 adds
  // a partial unique index ux_brief_lookups_wechat_per_lead, so a plain
  // INSERT would throw on repeat clicks. We want idempotent: marking
  // a lead "Added on WeChat" twice should leave exactly one conversion
  // row, with the newer metadata (notes, rep attribution) preserved.
  //
  // If lead_id is null (name-only lookup), the unique index doesn't
  // apply, and a plain insert is the right behavior — each name lookup
  // is its own event.
  const payload = {
    query,
    arxiv_id: arxiv_id || null,
    lead_id: lead_id || null,
    added_wechat: true,
    wechat_at: new Date().toISOString(),
    notes: notes || null,
    marked_by_rep_id: session.repId,
    marked_by_email: session.email,
  };
  const { data, error } = lead_id
    ? await supabase
        .from("brief_lookups")
        .upsert(payload, { onConflict: "lead_id", ignoreDuplicates: false })
        .select()
        .single()
    : await supabase
        .from("brief_lookups")
        .insert(payload)
        .select()
        .single();

  if (error) {
    // Log so we can diagnose legacy-email failures (e.g. missing
    // marked_by_rep_id column, partial-index conflicts, FK rejections).
    // The fire-and-forget UI used to swallow these silently.
    console.error("brief/wechat insert failed", {
      query,
      lead_id: lead_id || null,
      arxiv_id: arxiv_id || null,
      err: error.message,
      code: (error as { code?: string }).code,
    });
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
