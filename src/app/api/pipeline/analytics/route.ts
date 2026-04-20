import { NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import {
  DISCOVERY_SOURCES,
  KNOWN_CHANNELS,
  labelToDiscoverySource,
  normalizeSourceLabel,
  type SourceCode,
} from "@/lib/sources";
import { resolveCategory } from "@/lib/assignment";

/** Best-effort: a row's matched_directions is sometimes a comma-joined string,
 *  sometimes an array, sometimes null. resolveCategory handles all three. */
function resolveCategoryFromLead(md: unknown): string | null {
  if (md == null) return null;
  if (Array.isArray(md)) return resolveCategory(md as string[]);
  if (typeof md === "string") return resolveCategory(md);
  return null;
}

export async function GET() {
  const [
    { data: allLeads },
    { data: reps },
    { data: wechatConversions },
    { data: dailyLeads },
    discoveryCountsBySource,
  ] = await Promise.all([
    supabase
      .from("pipeline_leads")
      .select("id, status, lead_tier, assigned_rep_id, h_index, source, created_at, sent_at, author_email, matched_directions"),
    supabase.from("sales_reps").select("*").order("id"),
    supabase
      .from("brief_lookups")
      .select("id, query, added_wechat, wechat_at, created_at")
      .eq("added_wechat", true),
    supabase
      .from("pipeline_leads")
      .select("created_at, lead_tier")
      .gte("created_at", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()),
    fetchDiscoveryCounts(),
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

    // Rep × category breakdown — groups matched_directions up to the parent
    // category so admin can see "Leo wins at 具身 but does poorly on Agent".
    const byCat = new Map<string, { assigned: number; sent: number; wechat: number }>();
    for (const lead of repLeads) {
      const category = resolveCategoryFromLead(lead.matched_directions);
      const key = category ?? "(unmatched)";
      const entry = byCat.get(key) ?? { assigned: 0, sent: 0, wechat: 0 };
      entry.assigned++;
      if (lead.status === "sent" || lead.status === "replied") entry.sent++;
      const em = (lead.author_email as string | null)?.toLowerCase() ?? "";
      if (em && wechat.some((w) => (w.query as string | null)?.toLowerCase() === em)) entry.wechat++;
      byCat.set(key, entry);
    }
    const categories = Array.from(byCat.entries())
      .map(([name, s]) => ({
        name,
        assigned: s.assigned,
        sent: s.sent,
        wechat: s.wechat,
        convRate: s.sent > 0 ? Math.round((s.wechat / s.sent) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.assigned - a.assigned);

    return {
      rep: { id: rep.id, name: rep.name, sender_email: rep.sender_email, wechat_id: rep.wechat_id, active: rep.active },
      assigned,
      sent,
      replied,
      wechat: repWechat,
      convRate: repConvRate,
      tiers,
      categories,
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
      sources: buildSourceBreakdown(leads, reps ?? [], wechat, discoveryCountsBySource),
    },
    sales: { reps: repStats },
  });
}

/* ── Per-channel breakdown with per-rep allocation ──────────────────── */

interface RawLead {
  id: number;
  status: string;
  lead_tier: string | null;
  assigned_rep_id: number | null;
  source: string | null;
  author_email: string | null;
  matched_directions?: string | string[] | null;
}

interface RawRep {
  id: number;
  name: string;
}

interface RawWechat {
  query: string | null;
}

/**
 * Per-source counts from discovery_leads, keyed by short source code.
 * Surfaces the top-of-funnel from the Python scrapers — these rows
 * have not yet been promoted into pipeline_leads.
 */
async function fetchDiscoveryCounts(): Promise<Record<SourceCode, number>> {
  const empty: Record<SourceCode, number> = { hf: 0, ph: 0, github: 0, arxiv: 0 };
  const entries = await Promise.all(
    DISCOVERY_SOURCES.map(async (src) => {
      const { count, error } = await supabase
        .from("discovery_leads")
        .select("id", { count: "exact", head: true })
        .eq("source", src);
      // Swallow errors (e.g. table not yet migrated) so analytics still loads.
      if (error) return [src, 0] as const;
      return [src, count ?? 0] as const;
    }),
  );
  for (const [src, n] of entries) empty[src] = n;
  return empty;
}

function buildSourceBreakdown(
  leads: RawLead[],
  reps: RawRep[],
  wechat: RawWechat[],
  discoveryCounts: Record<SourceCode, number>,
) {
  const wechatEmails = new Set(
    wechat.map((w) => (w.query ?? "").toLowerCase()).filter(Boolean),
  );

  const grouped = new Map<string, RawLead[]>();
  for (const ch of KNOWN_CHANNELS) grouped.set(ch, []);
  for (const lead of leads) {
    const channel = normalizeSourceLabel(lead.source);
    if (!grouped.has(channel)) grouped.set(channel, []);
    grouped.get(channel)!.push(lead);
  }

  const repNameById = new Map(reps.map((r) => [r.id, r.name]));

  return Array.from(grouped.entries()).map(([source, channelLeads]) => {
    const total = channelLeads.length;
    const strong = channelLeads.filter((l) => l.lead_tier === "strong").length;
    const normal = total - strong;
    const sent = channelLeads.filter((l) => l.status === "sent" || l.status === "replied").length;
    const replied = channelLeads.filter((l) => l.status === "replied").length;
    const channelWechat = channelLeads.filter((l) =>
      wechatEmails.has((l.author_email ?? "").toLowerCase()),
    ).length;
    const convRate = sent > 0 ? Math.round((channelWechat / sent) * 1000) / 10 : 0;

    // arXiv has no discovery row — it lands directly in pipeline_leads.
    const discoverySrc = labelToDiscoverySource(source);
    const discovered = discoverySrc ? (discoveryCounts[discoverySrc] ?? 0) : 0;

    // Per-rep allocation within this channel
    const repCounts = new Map<number | null, number>();
    for (const lead of channelLeads) {
      const k = lead.assigned_rep_id ?? null;
      repCounts.set(k, (repCounts.get(k) ?? 0) + 1);
    }
    const reps = Array.from(repCounts.entries())
      .map(([repId, count]) => ({
        repId,
        repName: repId === null ? "Unassigned" : (repNameById.get(repId) ?? `Rep #${repId}`),
        count,
      }))
      .sort((a, b) => b.count - a.count);

    return {
      source,
      discovered,
      total,
      strong,
      normal,
      sent,
      replied,
      wechat: channelWechat,
      convRate,
      reps,
    };
  });
}

