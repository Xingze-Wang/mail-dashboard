import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET() {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [
    totalSent,
    totalDelivered,
    totalOpened,
    totalClicked,
    totalBounced,
    totalComplained,
    totalInbound,
    recentEvents,
    last7DaysSent,
    dailyStats,
  ] = await Promise.all([
    prisma.email.count({ where: { status: { not: "queued" } } }),
    prisma.email.count({ where: { status: "delivered" } }),
    prisma.email.count({ where: { status: "opened" } }),
    prisma.email.count({ where: { status: "clicked" } }),
    prisma.email.count({ where: { status: "bounced" } }),
    prisma.email.count({ where: { status: "complained" } }),
    prisma.inboundEmail.count(),
    prisma.webhookEvent.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { email: { select: { to: true, subject: true } } },
    }),
    prisma.email.count({
      where: { createdAt: { gte: sevenDaysAgo }, status: { not: "queued" } },
    }),
    // Get daily send counts for last 30 days
    prisma.email.findMany({
      where: { createdAt: { gte: thirtyDaysAgo } },
      select: { createdAt: true, status: true },
    }),
  ]);

  // Aggregate daily stats
  const dailyMap: Record<string, { sent: number; delivered: number; opened: number; bounced: number }> = {};
  for (let i = 29; i >= 0; i--) {
    const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const key = date.toISOString().split("T")[0];
    dailyMap[key] = { sent: 0, delivered: 0, opened: 0, bounced: 0 };
  }

  for (const email of dailyStats) {
    const key = email.createdAt.toISOString().split("T")[0];
    if (dailyMap[key]) {
      dailyMap[key].sent++;
      if (email.status === "delivered") dailyMap[key].delivered++;
      if (email.status === "opened") dailyMap[key].opened++;
      if (email.status === "bounced") dailyMap[key].bounced++;
    }
  }

  const deliveryRate = totalSent > 0 ? ((totalDelivered / totalSent) * 100).toFixed(1) : "0";
  const openRate = totalDelivered > 0 ? ((totalOpened / totalDelivered) * 100).toFixed(1) : "0";
  const clickRate = totalOpened > 0 ? ((totalClicked / totalOpened) * 100).toFixed(1) : "0";
  const bounceRate = totalSent > 0 ? ((totalBounced / totalSent) * 100).toFixed(1) : "0";

  return NextResponse.json({
    overview: {
      totalSent,
      totalDelivered,
      totalOpened,
      totalClicked,
      totalBounced,
      totalComplained,
      totalInbound,
      last7DaysSent,
      deliveryRate,
      openRate,
      clickRate,
      bounceRate,
    },
    dailyStats: Object.entries(dailyMap).map(([date, stats]) => ({
      date,
      ...stats,
    })),
    recentEvents: recentEvents.map((e) => ({
      id: e.id,
      type: e.type,
      createdAt: e.createdAt,
      to: e.email?.to,
      subject: e.email?.subject,
    })),
  });
}
