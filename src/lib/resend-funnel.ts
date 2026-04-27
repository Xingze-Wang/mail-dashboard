// Live funnel read from Resend.
//
// Click Tracking Rate (CTR) and the delivery funnel come DIRECTLY from
// Resend's list API, not from our Supabase mirror. Reasons:
//
//   - Our mirror depends on the sync loop + click-tracking webhook
//     actually firing. Both can lag or silently fail, and when they
//     do the dashboard shows 0 clicked for days, which has now bitten
//     us more than once.
//   - Resend's `last_event` on each email is the real authoritative
//     state. Paginate, count, done. No mirror drift.
//
// The only number that STAYS in our DB is WeChat adds — those are an
// app-level conversion event Resend doesn't know about.

import { resend } from "@/lib/resend";
import { mapResendEventToStatus, DELIVERED_STATUSES } from "@/lib/status";
import { beijingDaysAgoStartUtc } from "@/lib/override-quota";

export interface FunnelDaily {
  date: string; // YYYY-MM-DD, Beijing day
  sent: number;
  delivered: number;
  clicked: number;
  bounced: number;
}

export interface ResendFunnel {
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
  // For downstream set-math (conversion rate denominators, etc.)
  deliveredRecipients: Set<string>;
  scannedEmails: number;
  pagedUntil: string | null;
  truncated: boolean; // true if we hit the time/size budget before exhausting Resend
}

interface ListFilterOpts {
  /** If set, only count emails whose `from` address contains this substring (case-insensitive).
   *  Used to scope the funnel to a single rep. */
  fromContains?: string | null;
  /** Wall-clock budget in ms. Pagination stops when exceeded. */
  timeBudgetMs?: number;
  /** Max pages (safety cap). Resend allows 100/page; default 50 → 5000 emails. */
  maxPages?: number;
}

function addressContains(fromField: string | null | undefined, needle: string): boolean {
  if (!fromField) return false;
  return fromField.toLowerCase().includes(needle.toLowerCase());
}

function toLowerEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(/<([^>]+)>/);
  const addr = (m ? m[1] : raw).toLowerCase().trim();
  return addr.includes("@") ? addr : null;
}

/**
 * Pull the delivery funnel live from Resend.
 *
 * Runs in ~1-3s for a single rep (~300-1000 emails) and ~3-6s org-wide
 * (~1500-5000 emails). Everything fits in a serverless invocation.
 */
export async function getResendFunnel(opts: ListFilterOpts = {}): Promise<ResendFunnel> {
  const { fromContains = null, timeBudgetMs = 8000, maxPages = 50 } = opts;

  const start = Date.now();
  let pages = 0;
  let after: string | undefined;
  let pagedUntil: string | null = null;

  let totalSent = 0;
  let totalDelivered = 0;
  let totalClicked = 0;
  let totalBounced = 0;
  let totalComplained = 0;
  let totalOpened = 0;
  let last7DaysSent = 0;

  // 30-day daily buckets anchored on Beijing day boundary (matches the
  // override-quota / helper signals everywhere else in the app).
  const todayBeijing = new Date(Date.now() + 8 * 3600 * 1000);
  const dailyMap: Record<string, FunnelDaily> = {};
  for (let i = 29; i >= 0; i--) {
    const d = new Date(todayBeijing.getTime() - i * 86_400_000);
    const key = d.toISOString().split("T")[0];
    dailyMap[key] = { date: key, sent: 0, delivered: 0, clicked: 0, bounced: 0 };
  }
  const sevenDaysAgo = beijingDaysAgoStartUtc(7).getTime();

  const deliveredRecipients = new Set<string>();
  let scannedEmails = 0;
  let truncated = false;

  while (pages < maxPages) {
    if (Date.now() - start > timeBudgetMs) {
      truncated = true;
      break;
    }

    const params: { limit: number; after?: string } = { limit: 100 };
    if (after) params.after = after;

    const result = await resend.emails.list(params);
    if (result.error || !result.data) break;

    const page = result.data.data;
    if (!page || page.length === 0) break;

    for (const email of page) {
      scannedEmails++;

      // Per-rep scope: match substring on `from`. Resend's "from" is
      // typically `"Leo <leo@compute.miracleplus.com>"`.
      if (fromContains && !addressContains(email.from ?? null, fromContains)) continue;

      const status = mapResendEventToStatus(email.last_event);
      const createdMs = email.created_at ? new Date(email.created_at).getTime() : 0;

      // ── Totals (all-time) ──
      if (status !== "queued") totalSent++;
      if ((DELIVERED_STATUSES as readonly string[]).includes(status)) totalDelivered++;
      // emails.status is monotonic (latest event wins). A `clicked` row
      // implies delivered + opened. A `complained` row had to be delivered
      // to complain. So "ever clicked" = status ∈ {clicked}, "ever
      // delivered" = status ∈ DELIVERED_STATUSES. We mirror the logic
      // metrics/route.ts used to implement via union-of-sources; now
      // it's a single authoritative read.
      if (status === "clicked") totalClicked++;
      if (status === "bounced") totalBounced++;
      if (status === "complained") totalComplained++;
      if (status === "opened" || status === "clicked") totalOpened++;

      if (createdMs >= sevenDaysAgo && status !== "queued") last7DaysSent++;

      // ── Daily bins ──
      const dayKey = email.created_at ? new Date(email.created_at).toISOString().split("T")[0] : null;
      if (dayKey && dailyMap[dayKey]) {
        if (status !== "queued") dailyMap[dayKey].sent++;
        if ((DELIVERED_STATUSES as readonly string[]).includes(status)) dailyMap[dayKey].delivered++;
        if (status === "clicked") dailyMap[dayKey].clicked++;
        if (status === "bounced") dailyMap[dayKey].bounced++;
      }

      // ── Recipient set (for conversion denominators) ──
      if (status !== "queued" && status !== "bounced" && status !== "complained") {
        const to = toLowerEmail(Array.isArray(email.to) ? email.to[0] : email.to);
        if (to) deliveredRecipients.add(to);
      }
    }

    pagedUntil = page[page.length - 1]?.created_at ?? pagedUntil;
    pages++;

    if (!result.data.has_more) break;
    after = page[page.length - 1].id;
  }

  if (pages >= maxPages) truncated = true;

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
    scannedEmails,
    pagedUntil,
    truncated,
  };
}
