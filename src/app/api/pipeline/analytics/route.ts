import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

// Analytics must always reflect the live DB — "This week" is time-sensitive
// and drifts by a full day if cached. Force a fresh query on every hit.
export const dynamic = "force-dynamic";
export const revalidate = 0;
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

export async function GET(req: NextRequest) {
  // Auth required. Prior logic ran without a session and simply
  // skipped the scope filter, returning the entire team's roll-up to
  // unauthenticated callers. Now every analytics query must be
  // associated with a real session.
  const session = await requireSession(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const isPrivileged = session.role === "admin" || session.role === "senior";
  // Non-privileged users are hard-scoped to their own repId.
  const scopeRepId = isPrivileged ? null : session.repId;

  const [
    { data: allLeads },
    { data: reps },
    { data: wechatConversions },
    { data: dailyLeadsRaw },
    discoveryCountsBySource,
    deliveredRecipients,
    repBySenderEmail,
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
      .select("created_at, lead_tier, assigned_rep_id")
      .gte("created_at", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()),
    fetchDiscoveryCounts(),
    fetchDeliveredRecipients(),
    fetchRepRecipientCounts(),
  ]);

  // Scope the arrays to the current rep BEFORE any aggregation. The
  // downstream code treats these as ground truth.
  const leadsAll = allLeads ?? [];
  const leads = scopeRepId !== null
    ? leadsAll.filter((l) => l.assigned_rep_id === scopeRepId)
    : leadsAll;
  const dailyLeads = scopeRepId !== null
    ? (dailyLeadsRaw ?? []).filter((l) => (l as { assigned_rep_id?: number }).assigned_rep_id === scopeRepId)
    : (dailyLeadsRaw ?? []);
  const wechat = wechatConversions ?? [];
  // Lower-cased set of every email address we've successfully delivered to.
  // This is the right denominator for ANY conversion-rate calc — using
  // pipeline_leads.status='sent' (~30 rows) instead would report rates 30×
  // too high because most historical sends never went through pipeline_leads.
  const sentEmails: Set<string> = deliveredRecipients;

  // ── Channel stats ──
  const totalLeads = leads.length;
  const strongLeads = leads.filter((l) => l.lead_tier === "strong").length;
  const sentLeads = leads.filter((l) => l.status === "sent" || l.status === "replied").length;
  const hIndexValues = leads.map((l) => l.h_index).filter((v): v is number => v !== null);
  const avgHIndex = hIndexValues.length > 0
    ? Math.round((hIndexValues.reduce((a, b) => a + b, 0) / hIndexValues.length) * 10) / 10
    : 0;
  const wechatCount = wechat.length;
  // Real denominator: unique people we delivered email to (from `emails`).
  // Pipeline-only `sentLeads` would be a 30-row subset → 146% nonsense.
  const totalRecipients = sentEmails.size;
  const conversionRate = totalRecipients > 0
    ? Math.round((wechatCount / totalRecipients) * 1000) / 10
    : 0;

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
  // `assigned` still comes from pipeline_leads (only place rep assignment
  // exists). `sent` and `wechat` use the real email log so historical sends
  // count properly — that's why the 146% bug existed before.
  const wechatEmailSet = new Set(
    wechat.map((w) => (w.query as string | null)?.toLowerCase().trim()).filter(Boolean) as string[],
  );

  const repStats = (reps ?? []).map((rep) => {
    const repLeads = leads.filter((l) => l.assigned_rep_id === rep.id);
    const assigned = repLeads.length;

    // Real `sent` for THIS rep: the unique recipients we delivered to from
    // the rep's sender_email. Comes from emails.from join, not pipeline.
    const senderEmail = (rep.sender_email as string | undefined)?.toLowerCase().trim() ?? "";
    const repRecipients = repBySenderEmail.get(senderEmail) ?? new Set<string>();
    const sent = repRecipients.size;

    // `replied` is still pipeline-scoped (replied status only set there).
    const replied = repLeads.filter((l) => l.status === "replied").length;

    // WeChat conversions attributable to this rep = WeChat emails ∩ repRecipients.
    let repWechat = 0;
    for (const em of repRecipients) if (wechatEmailSet.has(em)) repWechat++;
    const repConvRate = sent > 0 ? Math.round((repWechat / sent) * 1000) / 10 : 0;

    // Per-tier within this rep: pipeline lead's tier × whether that lead's
    // recipient was actually delivered to (via repRecipients ∩).
    const tiers = ["strong", "normal"].map((tier) => {
      const tierLeads = repLeads.filter((l) => l.lead_tier === tier);
      const tierEmails = new Set(
        tierLeads
          .map((l) => (l.author_email as string | null)?.toLowerCase().trim())
          .filter(Boolean) as string[],
      );
      let tierSent = 0;
      let tierWechat = 0;
      for (const em of tierEmails) {
        if (repRecipients.has(em)) {
          tierSent++;
          if (wechatEmailSet.has(em)) tierWechat++;
        }
      }
      const tierReplied = tierLeads.filter((l) => l.status === "replied").length;
      return {
        tier,
        assigned: tierLeads.length,
        sent: tierSent,
        replied: tierReplied,
        wechat: tierWechat,
        convRate: tierSent > 0 ? Math.round((tierWechat / tierSent) * 1000) / 10 : 0,
      };
    });

    // Per-category. Same intersection rule.
    const byCat = new Map<string, { assigned: number; sent: number; wechat: number }>();
    for (const lead of repLeads) {
      const category = resolveCategoryFromLead(lead.matched_directions);
      const key = category ?? "(unmatched)";
      const entry = byCat.get(key) ?? { assigned: 0, sent: 0, wechat: 0 };
      entry.assigned++;
      const em = (lead.author_email as string | null)?.toLowerCase().trim() ?? "";
      if (em && repRecipients.has(em)) {
        entry.sent++;
        if (wechatEmailSet.has(em)) entry.wechat++;
      }
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
      sources: buildSourceBreakdown(leads, reps ?? [], wechat, discoveryCountsBySource, sentEmails),
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
 * All unique email addresses we've ACTUALLY delivered to. This is the
 * authoritative "we sent this person an email" set — pipeline_leads
 * only covers ~30 of 1100+ historical sends.
 */
async function fetchDeliveredRecipients(): Promise<Set<string>> {
  const emails = new Set<string>();
  let cursor = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("emails")
      .select("to")
      .in("status", ["delivered", "clicked", "sent", "replied"])
      .range(cursor, cursor + pageSize - 1);
    if (error || !data || data.length === 0) break;
    for (const r of data) {
      const em = (r.to as string | null)?.toLowerCase().trim();
      if (em) emails.add(em);
    }
    if (data.length < pageSize) break;
    cursor += pageSize;
    if (cursor > 20_000) break; // safety
  }
  return emails;
}

/**
 * For each rep (keyed by their sender_email), the set of unique recipients
 * they've actually delivered email to. Powers per-rep conversion rates that
 * use the right denominator.
 */
async function fetchRepRecipientCounts(): Promise<Map<string, Set<string>>> {
  const m = new Map<string, Set<string>>();
  let cursor = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("emails")
      .select("from, to")
      .in("status", ["delivered", "clicked", "sent", "replied"])
      .range(cursor, cursor + pageSize - 1);
    if (error || !data || data.length === 0) break;
    for (const r of data) {
      const fromAddr = extractEmailAddr(r.from as string | null);
      const toAddr = (r.to as string | null)?.toLowerCase().trim();
      if (!fromAddr || !toAddr) continue;
      const set = m.get(fromAddr) ?? new Set<string>();
      set.add(toAddr);
      m.set(fromAddr, set);
    }
    if (data.length < pageSize) break;
    cursor += pageSize;
    if (cursor > 20_000) break;
  }
  return m;
}

/** Pulls the bare email out of "Name <addr@x>". */
function extractEmailAddr(raw: string | null): string | null {
  if (!raw) return null;
  const match = raw.match(/<([^>]+)>/);
  const addr = (match ? match[1] : raw).toLowerCase().trim();
  return addr.includes("@") ? addr : null;
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
  sentEmails: Set<string>,
) {
  const wechatEmails = new Set(
    wechat.map((w) => (w.query ?? "").toLowerCase().trim()).filter(Boolean),
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
    // `sent` = unique recipients in this channel that we actually delivered
    // an email to (intersect with sentEmails). `replied` stays pipeline-scoped.
    const replied = channelLeads.filter((l) => l.status === "replied").length;
    const channelEmails = new Set(
      channelLeads
        .map((l) => (l.author_email ?? "").toLowerCase().trim())
        .filter(Boolean),
    );
    let sent = 0;
    let channelWechat = 0;
    for (const em of channelEmails) {
      if (sentEmails.has(em)) {
        sent++;
        if (wechatEmails.has(em)) channelWechat++;
      }
    }
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

