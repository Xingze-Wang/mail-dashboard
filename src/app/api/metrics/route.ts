import { NextResponse } from "next/server";
import { supabase } from "@/lib/db";

export async function GET() {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [
    { count: totalSent },
    { count: totalDelivered },
    { count: totalOpened },
    { count: totalClicked },
    { count: totalBounced },
    { count: totalComplained },
    { count: totalInbound },
    { data: recentEvents },
    { count: last7DaysSent },
    { data: dailyEmails },
  ] = await Promise.all([
    supabase.from("emails").select("*", { count: "exact", head: true }).neq("status", "queued"),
    supabase.from("emails").select("*", { count: "exact", head: true }).eq("status", "delivered"),
    supabase.from("emails").select("*", { count: "exact", head: true }).eq("status", "opened"),
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
      .gte("created_at", thirtyDaysAgo),
  ]);

  // Aggregate daily stats
  const dailyMap: Record<string, { sent: number; delivered: number; opened: number; bounced: number }> = {};
  for (let i = 29; i >= 0; i--) {
    const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const key = date.toISOString().split("T")[0];
    dailyMap[key] = { sent: 0, delivered: 0, opened: 0, bounced: 0 };
  }

  for (const email of dailyEmails || []) {
    const key = new Date(email.created_at).toISOString().split("T")[0];
    if (dailyMap[key]) {
      dailyMap[key].sent++;
      if (email.status === "delivered") dailyMap[key].delivered++;
      if (email.status === "opened") dailyMap[key].opened++;
      if (email.status === "bounced") dailyMap[key].bounced++;
    }
  }

  const ts = totalSent || 0;
  const td = totalDelivered || 0;
  const to2 = totalOpened || 0;
  const tc = totalClicked || 0;
  const tb = totalBounced || 0;

  const deliveryRate = ts > 0 ? ((td / ts) * 100).toFixed(1) : "0";
  const openRate = td > 0 ? ((to2 / td) * 100).toFixed(1) : "0";
  const clickRate = to2 > 0 ? ((tc / to2) * 100).toFixed(1) : "0";
  const bounceRate = ts > 0 ? ((tb / ts) * 100).toFixed(1) : "0";

  return NextResponse.json({
    overview: {
      totalSent: ts,
      totalDelivered: td,
      totalOpened: to2,
      totalClicked: tc,
      totalBounced: tb,
      totalComplained: totalComplained || 0,
      totalInbound: totalInbound || 0,
      last7DaysSent: last7DaysSent || 0,
      deliveryRate,
      openRate,
      clickRate,
      bounceRate,
    },
    dailyStats: Object.entries(dailyMap).map(([date, stats]) => ({ date, ...stats })),
    recentEvents: (recentEvents || []).map((e) => ({
      id: e.id,
      type: e.type,
      createdAt: e.created_at,
      to: (e.email as unknown as Record<string, string> | null)?.to,
      subject: (e.email as unknown as Record<string, string> | null)?.subject,
    })),
  });
}
