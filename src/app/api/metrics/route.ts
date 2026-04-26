import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";
import { getRep } from "@/lib/assignment";
import { getDbFunnel } from "@/lib/db-funnel";

// Live data every request — never cache.
export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/metrics
 *
 * Sent / delivered / clicked / bounced / daily chart all come from our
 * local emails table. Webhooks (api/webhook) keep status fresh per-event
 * and the daily cron sync (lib/sync.syncFromResend) drains anything the
 * webhooks missed. This is fast (~150ms), exhaustive (no pagination
 * truncation), and not subject to Resend's 5-rps API limit.
 *
 * Prior version read live from Resend on every request, which paginated
 * 14 pages × ~600ms = past the 8s budget and returned partial counts
 * (281 of 1382 emails). Never repeat that pattern: any total displayed
 * to the user must come from a source we control end-to-end. If we
 * can't trust our mirror, FIX the mirror, don't fall back to live.
 *
 * WeChat stays DB-derived because it's our app's conversion event
 * (brief_lookups.added_wechat) — Resend doesn't know about it.
 */
export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const isPrivileged = session.role === "admin";

  // Per-rep scope: match Resend's `from` field on the rep's sender_email
  // substring. Admin sees the org-wide funnel.
  let fromContains: string | null = null;
  if (!isPrivileged) {
    const rep = await getRep(session.repId);
    if (!rep?.sender_email) {
      // Rep has no sender address → nothing to show (don't leak org totals).
      return NextResponse.json(emptyResponse());
    }
    fromContains = rep.sender_email;
  }

  // DB-derived funnel: exhaustive, fast, no rate-limit risk.
  const funnel = await getDbFunnel({ fromContains });

  // Recent activity feed — synthesize from the funnel we just pulled.
  // (We no longer need webhook_events for this.)
  // For the MVP, use a lightweight emails list from Resend directly.
  // Pull last 20 distinct events.
  const recentEvents = await recentActivityFromResend(fromContains, 20);

  // ── Pipeline + WeChat (DB-derived, unchanged) ──
  let readyQ = supabase.from("pipeline_leads").select("*", { count: "exact", head: true }).eq("status", "ready");
  let sentQ = supabase.from("pipeline_leads").select("*", { count: "exact", head: true }).eq("status", "sent");
  let totalQ = supabase.from("pipeline_leads").select("*", { count: "exact", head: true });
  if (!isPrivileged) {
    readyQ = readyQ.eq("assigned_rep_id", session.repId);
    sentQ = sentQ.eq("assigned_rep_id", session.repId);
    totalQ = totalQ.eq("assigned_rep_id", session.repId);
  }

  const [
    { count: pipelineReady },
    { count: pipelineSent },
    { count: pipelineTotal },
    { count: wechatTotal },
    { data: recentWechat },
    { count: totalInbound },
  ] = await Promise.all([
    readyQ,
    sentQ,
    totalQ,
    isPrivileged
      ? supabase.from("brief_lookups").select("*", { count: "exact", head: true }).eq("added_wechat", true)
      : supabase.from("brief_lookups").select("*", { count: "exact", head: true }).eq("added_wechat", true).eq("marked_by_rep_id", session.repId),
    isPrivileged
      ? supabase.from("brief_lookups").select("query, arxiv_id, created_at").eq("added_wechat", true).order("created_at", { ascending: false }).limit(10)
      : supabase.from("brief_lookups").select("query, arxiv_id, created_at").eq("added_wechat", true).eq("marked_by_rep_id", session.repId).order("created_at", { ascending: false }).limit(10),
    // Inbound total (per-rep scoped via thread join if needed).
    inboundCount(isPrivileged ? null : await inboundThreadScope(fromContains)),
  ]);

  return NextResponse.json({
    overview: {
      totalSent: funnel.totalSent,
      totalDelivered: funnel.totalDelivered,
      totalClicked: funnel.totalClicked,
      totalBounced: funnel.totalBounced,
      totalComplained: funnel.totalComplained,
      totalInbound: totalInbound ?? 0,
      last7DaysSent: funnel.last7DaysSent,
      deliveryRate: funnel.deliveryRate,
      clickRate: funnel.clickRate,
      bounceRate: funnel.bounceRate,
    },
    pipeline: {
      ready: pipelineReady ?? 0,
      sent: pipelineSent ?? 0,
      total: pipelineTotal ?? 0,
    },
    wechat: {
      total: wechatTotal ?? 0,
      recent: (recentWechat ?? []).map((r) => ({
        query: r.query,
        arxivId: r.arxiv_id,
        createdAt: r.created_at,
      })),
    },
    dailyStats: funnel.daily,
    recentEvents,
    _source: {
      funnel: "db",
      wechat: "db",
      scannedEmails: funnel.scannedEmails,
      truncated: funnel.truncated,
    },
  });
}

/** Empty response shape — used when the session has no sender_email. */
function emptyResponse() {
  return {
    overview: {
      totalSent: 0, totalDelivered: 0, totalClicked: 0, totalBounced: 0,
      totalComplained: 0, totalInbound: 0, last7DaysSent: 0,
      deliveryRate: "0", clickRate: "0", bounceRate: "0",
    },
    pipeline: { ready: 0, sent: 0, total: 0 },
    wechat: { total: 0, recent: [] },
    dailyStats: [],
    recentEvents: [],
    _source: { funnel: "empty", wechat: "empty" },
  };
}

async function inboundThreadScope(fromContains: string | null): Promise<string[]> {
  if (!fromContains) return [];
  const { data } = await supabase
    .from("emails")
    .select("thread_id")
    .ilike("from", `%${fromContains}%`)
    .not("thread_id", "is", null);
  return (data ?? [])
    .map((r) => r.thread_id as string | null)
    .filter((t): t is string => !!t);
}

async function inboundCount(threadIdScope: string[] | null): Promise<{ count: number }> {
  if (threadIdScope !== null && threadIdScope.length === 0) return { count: 0 };
  let q = supabase.from("inbound_emails").select("*", { count: "exact", head: true });
  if (threadIdScope !== null) q = q.in("thread_id", threadIdScope);
  const { count } = await q;
  return { count: count ?? 0 };
}

async function recentActivityFromResend(fromContains: string | null, limit: number) {
  // Read recent activity from the local emails table — no live API call.
  // Webhooks keep status fresh; sync drains anything missed. The "ticker"
  // synthesizes events from each row's current status, ordered newest first.
  let q = supabase
    .from("emails")
    .select("id, resend_id, from, to, subject, status, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (fromContains) q = q.ilike("from", `%${fromContains}%`);
  const { data } = await q;
  return (data ?? []).map((e) => ({
    id: e.resend_id ?? e.id,
    type: `email.${e.status ?? "sent"}`,
    createdAt: e.created_at,
    to: e.to,
    subject: e.subject,
  }));
}

