import { NextResponse } from "next/server";
import { supabase } from "@/lib/db";

export async function GET() {
  const [
    { data: allLeads },
    { data: reps },
    { data: wechatConversions },
    { data: dailyLeads },
  ] = await Promise.all([
    supabase
      .from("pipeline_leads")
      .select("id, status, lead_tier, assigned_rep_id, h_index, source, created_at, sent_at, author_email"),
    supabase.from("sales_reps").select("*").order("id"),
    supabase
      .from("brief_lookups")
      .select("id, query, added_wechat, wechat_at, created_at")
      .eq("added_wechat", true),
    supabase
      .from("pipeline_leads")
      .select("created_at, lead_tier")
      .gte("created_at", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()),
  ]);

  const leads = allLeads ?? [];
  const wechat = wechatConversions ?? [];

  // ── Channel stats ──
  const totalLeads = leads.length;
  const strongLeads = leads.filter((l) => l.lead_tier === "strong").length;
  const sentLeads = leads.filter((l) => l.status === "sent" || l.status === "replied").length;
  const hIndexValues = leads.map((l) => l.h_index).filter((v): v is number => v !== null);
  const avgHIndex = hIndexValues.length > 0
    ? Math.round((hIndexValues.reduce((a, b) => a + b, 0) / hIndexValues.length) * 10) / 10
    : 0;
  const wechatCount = wechat.length;
  const conversionRate = sentLeads > 0 ? Math.round((wechatCount / sentLeads) * 1000) / 10 : 0;

  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const leadsThisWeek = leads.filter((l) => l.created_at >= oneWeekAgo).length;

  // ── Daily breakdown (last 30 days) ──
  const dailyMap = new Map<string, { strong: number; normal: number }>();
  for (const l of dailyLeads ?? []) {
    const day = l.created_at.split("T")[0];
    const entry = dailyMap.get(day) ?? { strong: 0, normal: 0 };
    if (l.lead_tier === "strong") entry.strong++;
    else entry.normal++;
    dailyMap.set(day, entry);
  }

  const daily = Array.from(dailyMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, counts]) => ({ date, ...counts }));

  // ── h-index distribution ──
  const hIndexBuckets = [0, 5, 10, 15, 20, 25, 30, 35, 40, 50, 75, 100];
  const hIndexDist = hIndexBuckets.map((min, i) => {
    const max = hIndexBuckets[i + 1] ?? Infinity;
    const count = hIndexValues.filter((v) => v >= min && v < max).length;
    return { min, max: max === Infinity ? null : max, count };
  });

  // ── Per-rep stats ──
  const repStats = (reps ?? []).map((rep) => {
    const repLeads = leads.filter((l) => l.assigned_rep_id === rep.id);
    const assigned = repLeads.length;
    const sent = repLeads.filter((l) => l.status === "sent" || l.status === "replied").length;
    const replied = repLeads.filter((l) => l.status === "replied").length;

    const repEmails = new Set(repLeads.map((l) => (l.author_email as string)?.toLowerCase()));
    const repWechat = wechat.filter((w) =>
      repEmails.has((w.query as string)?.toLowerCase()),
    ).length;

    const repConvRate = sent > 0 ? Math.round((repWechat / sent) * 1000) / 10 : 0;

    const tiers = ["strong", "normal"].map((tier) => {
      const tierLeads = repLeads.filter((l) => l.lead_tier === tier);
      const tierSent = tierLeads.filter((l) => l.status === "sent" || l.status === "replied").length;
      const tierReplied = tierLeads.filter((l) => l.status === "replied").length;
      const tierEmails = new Set(tierLeads.map((l) => (l.author_email as string)?.toLowerCase()));
      const tierWechat = wechat.filter((w) => tierEmails.has((w.query as string)?.toLowerCase())).length;
      return {
        tier,
        assigned: tierLeads.length,
        sent: tierSent,
        replied: tierReplied,
        wechat: tierWechat,
        convRate: tierSent > 0 ? Math.round((tierWechat / tierSent) * 1000) / 10 : 0,
      };
    });

    return {
      rep: { id: rep.id, name: rep.name, sender_email: rep.sender_email, wechat_id: rep.wechat_id, active: rep.active },
      assigned,
      sent,
      replied,
      wechat: repWechat,
      convRate: repConvRate,
      tiers,
    };
  });

  return NextResponse.json({
    channels: {
      totalLeads,
      strongLeads,
      leadsThisWeek,
      avgHIndex,
      sentLeads,
      wechatCount,
      conversionRate,
      daily,
      hIndexDist,
      sources: [
        {
          source: "arXiv",
          total: totalLeads,
          strong: strongLeads,
          normal: totalLeads - strongLeads,
          sent: sentLeads,
          wechat: wechatCount,
          convRate: conversionRate,
        },
      ],
    },
    sales: { reps: repStats },
  });
}
