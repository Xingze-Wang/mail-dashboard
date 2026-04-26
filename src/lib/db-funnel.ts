// DB-derived funnel — same shape as getResendFunnel but reads our local
// emails table instead of paginating Resend's API on every dashboard load.
//
// Why we switched: paginating Resend live cost ~600ms per page and hit a
// 5-rps rate limit. With ~1400 emails the funnel needed 14 pages, ran
// past the 8s time budget, and returned partial counts (281 instead of
// the real ~1400). Webhooks already keep the DB fresh per-event; the
// nightly sync drains anything webhooks miss. So the DB is the right
// authoritative source — fast (~50ms) and correct.

import { supabase } from "@/lib/db";
import { DELIVERED_STATUSES } from "@/lib/status";
import { beijingDaysAgoStartUtc } from "@/lib/override-quota";

export interface FunnelDaily {
  date: string;
  sent: number;
  delivered: number;
  clicked: number;
  bounced: number;
}

export interface DbFunnel {
  totalSent: number;
  totalDelivered: number;
  totalClicked: number;
  totalBounced: number;
  totalComplained: number;
  totalOpened: number;
  last7DaysSent: number;
  deliveryRate: string;
  clickRate: string;
  bounceRate: string;
  daily: FunnelDaily[];
  deliveredRecipients: Set<string>;
  scannedEmails: number;
  pagedUntil: string | null;
  truncated: boolean;
}

interface FunnelOpts {
  /** Only count emails whose `from` address contains this substring (case-insensitive). */
  fromContains?: string | null;
}

function toLowerEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(/<([^>]+)>/);
  const addr = (m ? m[1] : raw).toLowerCase().trim();
  return addr.includes("@") ? addr : null;
}

interface EmailRow {
  to: string | null;
  from: string | null;
  status: string | null;
  created_at: string | null;
}

export async function getDbFunnel(opts: FunnelOpts = {}): Promise<DbFunnel> {
  const { fromContains = null } = opts;

  // Pull every email in one go — paginated only because Supabase caps
  // REST results at 1000 per request. At our volume this is ~2 round
  // trips (~150ms total), versus ~8s for the live Resend version.
  const all: EmailRow[] = [];
  let cursor = 0;
  const pageSize = 1000;
  while (true) {
    let q = supabase
      .from("emails")
      .select("to, from, status, created_at")
      .order("created_at", { ascending: false })
      .range(cursor, cursor + pageSize - 1);
    if (fromContains) q = q.ilike("from", `%${fromContains}%`);
    const { data, error } = await q;
    if (error || !data || data.length === 0) break;
    all.push(...(data as EmailRow[]));
    if (data.length < pageSize) break;
    cursor += pageSize;
    if (cursor > 100_000) break; // safety
  }

  // Initialize 30-day daily bins anchored on Beijing day boundary.
  const todayBeijing = new Date(Date.now() + 8 * 3600 * 1000);
  const dailyMap: Record<string, FunnelDaily> = {};
  for (let i = 29; i >= 0; i--) {
    const d = new Date(todayBeijing.getTime() - i * 86_400_000);
    const key = d.toISOString().split("T")[0];
    dailyMap[key] = { date: key, sent: 0, delivered: 0, clicked: 0, bounced: 0 };
  }
  const sevenDaysAgo = beijingDaysAgoStartUtc(7).getTime();

  // Email status is monotonic — "latest event wins". A clicked row was
  // also delivered; a complained row was also delivered. We mirror the
  // funnel logic from resend-funnel.ts so totals match what the live
  // version returned (when it didn't time out).
  let totalSent = 0;
  let totalDelivered = 0;
  let totalClicked = 0;
  let totalBounced = 0;
  let totalComplained = 0;
  let totalOpened = 0;
  let last7DaysSent = 0;
  const deliveredRecipients = new Set<string>();
  let pagedUntil: string | null = null;

  for (const e of all) {
    const status = (e.status ?? "sent").toLowerCase();
    const createdMs = e.created_at ? new Date(e.created_at).getTime() : 0;

    if (status !== "queued") totalSent++;
    if ((DELIVERED_STATUSES as readonly string[]).includes(status)) totalDelivered++;
    if (status === "clicked") totalClicked++;
    if (status === "bounced") totalBounced++;
    if (status === "complained") totalComplained++;
    if (status === "opened" || status === "clicked") totalOpened++;

    if (createdMs >= sevenDaysAgo && status !== "queued") last7DaysSent++;

    const dayKey = e.created_at ? new Date(e.created_at).toISOString().split("T")[0] : null;
    if (dayKey && dailyMap[dayKey]) {
      if (status !== "queued") dailyMap[dayKey].sent++;
      if ((DELIVERED_STATUSES as readonly string[]).includes(status)) dailyMap[dayKey].delivered++;
      if (status === "clicked") dailyMap[dayKey].clicked++;
      if (status === "bounced") dailyMap[dayKey].bounced++;
    }

    // For conversion-rate denominators downstream.
    if (status !== "queued" && status !== "bounced" && status !== "complained") {
      const to = toLowerEmail(e.to);
      if (to) deliveredRecipients.add(to);
    }

    pagedUntil = e.created_at ?? pagedUntil;
  }

  const deliveryRate = totalSent > 0 ? ((totalDelivered / totalSent) * 100).toFixed(1) : "0";
  const clickRate = totalDelivered > 0 ? ((totalClicked / totalDelivered) * 100).toFixed(1) : "0";
  const bounceRate = totalSent > 0 ? ((totalBounced / totalSent) * 100).toFixed(1) : "0";

  return {
    totalSent,
    totalDelivered,
    totalClicked,
    totalBounced,
    totalComplained,
    totalOpened,
    last7DaysSent,
    deliveryRate,
    clickRate,
    bounceRate,
    daily: Object.values(dailyMap),
    deliveredRecipients,
    scannedEmails: all.length,
    pagedUntil,
    truncated: false, // DB read is exhaustive within safety cap
  };
}
