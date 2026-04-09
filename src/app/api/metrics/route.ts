import { NextResponse } from "next/server";
import { supabase } from "@/lib/db";

// Status progression: clicked implies delivered, delivered implies sent
const DELIVERED_STATUSES = ["delivered", "clicked", "complained"];

export async function GET() {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [
    { count: totalSent },
    { count: totalDelivered },
    { count: totalClicked },
    { count: totalBounced },
    { count: totalComplained },
    { count: totalInbound },
    { data: recentEvents },
    { count: last7DaysSent },
    { data: dailyEmails },
  ] = await Promise.all([
    supabase.from("emails").select("*", { count: "exact", head: true }).neq("status", "queued"),
    supabase.from("emails").select("*", { count: "exact", head: true }).in("status", DELIVERED_STATUSES),
    supabase.from("emails").select("*", { count: "exact", head: true }).eq("status", "clicked"),
    supabase.from("emails").select("*", { count: "exact", head: true }).eq("status", "bounced"),
    supabase.from("emails").select("*", { count: "exact", head: true }).eq("status", "complained"),
    supabase.from("inbound_emails").select("*", { count: "exact", head: true }),
    supabase
      .from("webhook_events")
      .select("id, type, created_at, email:emails(to, subject)")
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("emails")
      .select("*", { count: "exact", head: true })
      .neq("status", "queued")
      .gte("created_at", sevenDaysAgo),
    supabase
      .from("emails")
      .select("created_at, status")
      .neq("status", "queued")
      .gte("created_at", thirtyDaysAgo),
  ]);

  // Aggregate daily stats
  const dailyMap: Record<string, { sent: number; delivered: number; clicked: number; bounced: number }> = {};
  for (let i = 29; i >= 0; i--) {
    const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const key = date.toISOString().split("T")[0];
    dailyMap[key] = { sent: 0, delivered: 0, clicked: 0, bounced: 0 };
  }

  for (const email of dailyEmails || []) {
    const key = new Date(email.created_at).toISOString().split("T")[0];
    if (dailyMap[key]) {
      dailyMap[key].sent++;
      if (DELIVERED_STATUSES.includes(email.status)) dailyMap[key].delivered++;
      if (email.status === "clicked") dailyMap[key].clicked++;
      if (email.status === "bounced") dailyMap[key].bounced++;
    }
  }

  const ts = totalSent || 0;
  const td = totalDelivered || 0;
  const tc = totalClicked || 0;
  const tb = totalBounced || 0;

  const deliveryRate = ts > 0 ? ((td / ts) * 100).toFixed(1) : "0";
  const clickRate = td > 0 ? ((tc / td) * 100).toFixed(1) : "0";
  const bounceRate = ts > 0 ? ((tb / ts) * 100).toFixed(1) : "0";

  // Recent events — use webhook_events if available, otherwise synthesize from emails
  let formattedEvents;
  if (recentEvents && recentEvents.length > 0) {
    formattedEvents = recentEvents.map((e) => ({
      id: e.id,
      type: e.type,
      createdAt: e.created_at,
      to: (e.email as unknown as Record<string, string> | null)?.to,
      subject: (e.email as unknown as Record<string, string> | null)?.subject,
    }));
  } else {
    const { data: recentEmails } = await supabase
      .from("emails")
      .select("id, to, subject, status, updated_at")
      .neq("status", "queued")
      .order("updated_at", { ascending: false })
      .limit(20);

    formattedEvents = (recentEmails || []).map((e) => ({
      id: e.id,
      type: `email.${e.status}`,
      createdAt: e.updated_at,
      to: e.to,
      subject: e.subject,
    }));
  }

  // Pipeline stats + WeChat
  const [
    { count: pipelineReady },
    { count: pipelineSent },
    { count: pipelineTotal },
    { count: wechatTotal },
    { data: recentWechat },
  ] = await Promise.all([
    supabase.from("pipeline_leads").select("*", { count: "exact", head: true }).eq("status", "ready"),
    supabase.from("pipeline_leads").select("*", { count: "exact", head: true }).eq("status", "sent"),
    supabase.from("pipeline_leads").select("*", { count: "exact", head: true }),
    supabase.from("brief_lookups").select("*", { count: "exact", head: true }).eq("added_wechat", true),
    supabase.from("brief_lookups").select("query, arxiv_id, created_at").eq("added_wechat", true).order("created_at", { ascending: false }).limit(10),
  ]);

  return NextResponse.json({
    overview: {
      totalSent: ts,
      totalDelivered: td,
      totalClicked: tc,
      totalBounced: tb,
      totalComplained: totalComplained || 0,
      totalInbound: totalInbound || 0,
      last7DaysSent: last7DaysSent || 0,
      deliveryRate,
      clickRate,
      bounceRate,
    },
    pipeline: {
      ready: pipelineReady || 0,
      sent: pipelineSent || 0,
      total: pipelineTotal || 0,
    },
    wechat: {
      total: wechatTotal || 0,
      recent: (recentWechat || []).map((r) => ({
        query: r.query,
        arxivId: r.arxiv_id,
        createdAt: r.created_at,
      })),
    },
    dailyStats: Object.entries(dailyMap).map(([date, stats]) => ({ date, ...stats })),
    recentEvents: formattedEvents,
  });
}
