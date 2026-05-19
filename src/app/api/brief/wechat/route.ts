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
  // 2026-05-19: the upsert path used to use { onConflict: "lead_id" } but
  // brief_lookups doesn't have a plain UNIQUE on lead_id — only the
  // partial index ux_brief_lookups_wechat_per_lead (mig 016) which
  // Postgres rejects for ON CONFLICT: "no unique or exclusion constraint
  // matching the ON CONFLICT specification". Result: every "Mark: Added
  // on WeChat" button click 500'd silently. Switching to find-or-update:
  // look up the existing wechat row for this lead_id, update if found,
  // insert if not. Same idempotency guarantee with less reliance on the
  // partial index. Race-safe enough — the partial index still blocks
  // duplicate `added_wechat=true` rows at the DB level if two clicks
  // truly land simultaneously.
  let data, error;
  if (lead_id) {
    const { data: existing } = await supabase
      .from("brief_lookups")
      .select("id")
      .eq("lead_id", lead_id)
      .eq("added_wechat", true)
      .maybeSingle();
    if (existing?.id) {
      const r = await supabase
        .from("brief_lookups")
        .update(payload)
        .eq("id", existing.id)
        .select()
        .single();
      data = r.data; error = r.error;
    } else {
      const r = await supabase
        .from("brief_lookups")
        .insert(payload)
        .select()
        .single();
      data = r.data; error = r.error;
    }
  } else {
    const r = await supabase
      .from("brief_lookups")
      .insert(payload)
      .select()
      .single();
    data = r.data; error = r.error;
  }

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

  // ── Contract attribution: a wechat add is worth real points to whichever
  //    company contract is active over (this rep, this lead's segment).
  try {
    const { attributeEventToContract } = await import("@/lib/contracts");
    let segment: string | null = null;
    const recipientEmail = String(query || "").toLowerCase();
    const m = recipientEmail.match(/[\w.+-]+@[\w.-]+/);
    if (m) {
      const domain = m[0].split("@")[1] ?? "";
      segment = domain.endsWith(".cn") ? "Domestic (.cn)" : "Overseas";
    }
    await attributeEventToContract({
      rep_id: session.repId,
      segment,
      event_kind: "wechat",
      occurred_at: new Date().toISOString(),
      source_kind: "brief_lookup",
      source_id: (data as { id?: string } | null)?.id ?? null,
    });
  } catch (err) {
    console.error("[wechat] contract attribution failed", err);
  }

  // Mission progress: the rep who marked this gets credit on their
  // 'mark_wechat' mission today. Same fire-and-forget pattern as
  // pipeline/send.
  try {
    const { bumpMissionProgress } = await import("@/lib/missions");
    bumpMissionProgress(session.repId, "mark_wechat", 1).catch((e) => {
      console.error("bumpMissionProgress (wechat) failed (non-blocking)", e);
    });
  } catch (e) {
    console.error("bumpMissionProgress (wechat) sync throw (non-blocking)", e);
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
