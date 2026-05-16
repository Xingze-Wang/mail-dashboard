// Canonical source of truth for every numeric count surfaced anywhere in
// the app (UI cards, /api routes, Lark bot answers, daily briefs, etc.).
//
// Why this exists
// ───────────────
// Before this module, 46 distinct call sites computed counts of the same
// underlying objects (leads, sent emails, replies, wechat conversions)
// with subtly different predicates and scoping. On 2026-05-16 the
// /pipeline page showed "1,000 active leads" in the subtitle while the
// "Total leads" card on the same page said 3,081 — the subtitle came
// from `leads.length` (a paginated array silently capped at 1000 by
// Supabase PostgREST), the card came from a `count: exact` query. Two
// different paths to the same answer disagreed by 3x.
//
// Every numeric thing the user sees must flow through this module.
// New count? Add a primitive here, not a one-off query at the call site.
// If you find yourself writing `.from("pipeline_leads").select("*", {
// count: "exact" })` outside this file, you are adding a future bug.
//
// Conventions
// ───────────
//   • Counts: always `{ count: "exact", head: true }`. Never `.length`
//     after a `.select(...)` — that silently caps at PostgREST's 1000-row
//     default and "looks fine" in dev with small data.
//   • Fetches: always `.range(cursor, cursor + 999)` paginated. The
//     `fetchAll*` helpers loop until exhausted.
//   • Every public function returns the predicate it built alongside the
//     number — so a consumer can console.log `result.predicate` and
//     reproduce the count by hand when something looks off.
//   • Read-only by design. No writes.
//   • Status constants come from `src/lib/status.ts`. Do not hand-roll
//     `["sent", "replied"]` here either.

import { supabase } from "@/lib/db";
import {
  CONTACTED_LEAD_STATUSES,
  REACHABLE_EMAIL_STATUSES,
  REPLIED_LEAD_STATUSES,
  type LeadStatus,
} from "@/lib/status";

// ── Filter shapes ───────────────────────────────────────────────────────

export type LeadFilter = {
  /** assigned_rep_id — owner. Do NOT use for "who sent" attribution. */
  repId?: number;
  status?: LeadStatus | readonly LeadStatus[];
  tier?: "strong" | "normal";
  /** ISO timestamp lower bound on created_at (when the lead was imported). */
  since?: string;
  /** ISO timestamp upper bound on created_at. */
  until?: string;
  /** ISO timestamp lower bound on sent_at (when the email actually went out).
   *  Use this — not `since` — for "sent today / this week" counts. */
  sentSince?: string;
  /** ISO timestamp upper bound on sent_at. */
  sentUntil?: string;
  /** geo bucket — derived from author_email domain via lib/geo. */
  geo?: "cn" | "edu" | "overseas";
};

export type EmailFilter = {
  /** actor_rep_id — WHO PERFORMED THE SEND. Use this, not assigned_rep_id. */
  actorRepId?: number;
  /** Accepts any string so callers can pass `REACHABLE_EMAIL_STATUSES`
   *  (which includes the lead-layer "replied" by convention — see
   *  status.ts header). countSent does not type-narrow this further. */
  status?: string | readonly string[];
  since?: string;
  until?: string;
};

export type ReplyFilter = {
  /** inbound_emails.rep_id — stamped at write time. */
  repId?: number;
  /** Restrict to threads this rep sent on (for legacy rows where rep_id is null). */
  threadIds?: readonly string[];
  /** ISO timestamp lower bound on created_at. */
  since?: string;
  isRead?: boolean;
};

export type WechatFilter = {
  /** brief_lookups.marked_by_rep_id — who recorded the conversion. */
  markedByRepId?: number;
  since?: string;
  until?: string;
};

// ── Cache ───────────────────────────────────────────────────────────────
//
// 30s in-memory cache. These counts are read-heavy (dashboard polling,
// helper bot tools) and don't need second-by-second freshness. Bypass
// via `{ cache: false }` when invalidating after a write.

type CacheEntry = { value: unknown; expiresAt: number };
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, CacheEntry>();

function cacheKey(fnName: string, filter: unknown): string {
  return `${fnName}:${JSON.stringify(filter ?? {})}`;
}

async function memoize<T>(
  fnName: string,
  filter: unknown,
  opts: { cache?: boolean } | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (opts?.cache === false) return fn();
  const k = cacheKey(fnName, filter);
  const hit = cache.get(k);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;
  const value = await fn();
  cache.set(k, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/** Clear the entire cache. Call after writes that would change counts. */
export function invalidateCanonicalCountsCache(): void {
  cache.clear();
}

// ── pipeline_leads ──────────────────────────────────────────────────────

type Opts = { cache?: boolean };

/**
 * Count rows in pipeline_leads matching the filter.
 *
 * @returns `{ count, predicate }` — predicate is the resolved filter so you
 *   can log it and reproduce the count by hand if something looks off.
 */
export async function countLeads(
  filter: LeadFilter = {},
  opts?: Opts,
): Promise<{ count: number; predicate: LeadFilter }> {
  return memoize("countLeads", filter, opts, async () => {
    let q = supabase.from("pipeline_leads").select("*", { count: "exact", head: true });
    if (filter.repId !== undefined) q = q.eq("assigned_rep_id", filter.repId);
    if (filter.status) {
      if (Array.isArray(filter.status)) q = q.in("status", filter.status as readonly string[]);
      else q = q.eq("status", filter.status);
    }
    if (filter.tier) q = q.eq("lead_tier", filter.tier);
    if (filter.since) q = q.gte("created_at", filter.since);
    if (filter.until) q = q.lt("created_at", filter.until);
    if (filter.sentSince) q = q.gte("sent_at", filter.sentSince);
    if (filter.sentUntil) q = q.lt("sent_at", filter.sentUntil);
    // geo is derived (not a column) — applied at fetchAll time, not here.
    // For counts, geo filtering requires fetching + filtering in JS;
    // callers that need geo-scoped counts should use fetchAllLeads
    // instead. This is documented because subtle-WRONG counts (silent
    // geo mismatch) are exactly what this module exists to prevent.
    if (filter.geo) {
      throw new Error(
        "countLeads: geo filter requires JS-side bucketing. Use fetchAllLeads({ geo }) then .length.",
      );
    }
    const { count, error } = await q;
    if (error) throw new Error(`countLeads failed: ${error.message}`);
    return { count: count ?? 0, predicate: filter };
  });
}

/**
 * One round-trip per status bucket, returns all of them. Use when a UI
 * card shows multiple status counts side by side (ready / sent /
 * replied / total) — fewer queries than calling countLeads N times.
 */
export async function countLeadsByStatus(
  filter: Omit<LeadFilter, "status"> = {},
  opts?: Opts,
): Promise<{
  byStatus: Record<LeadStatus, number>;
  contacted: number;
  replied: number;
  total: number;
  predicate: Omit<LeadFilter, "status">;
}> {
  return memoize("countLeadsByStatus", filter, opts, async () => {
    const statuses: LeadStatus[] = [
      "new", "queued", "drafting", "ready", "sending", "sent", "replied", "skipped",
    ];
    const counts = await Promise.all(
      statuses.map((s) => countLeads({ ...filter, status: s }, { cache: opts?.cache })),
    );
    const total = await countLeads(filter, { cache: opts?.cache });
    const byStatus = Object.fromEntries(
      statuses.map((s, i) => [s, counts[i].count]),
    ) as Record<LeadStatus, number>;
    const contacted = (CONTACTED_LEAD_STATUSES as readonly string[]).reduce(
      (sum, s) => sum + (byStatus[s as LeadStatus] ?? 0),
      0,
    );
    const replied = (REPLIED_LEAD_STATUSES as readonly string[]).reduce(
      (sum, s) => sum + (byStatus[s as LeadStatus] ?? 0),
      0,
    );
    return { byStatus, contacted, replied, total: total.count, predicate: filter };
  });
}

/**
 * Paginated fetch — returns ALL matching rows, never silently capped at
 * 1000. Use when the caller needs row contents, not just a count.
 *
 * `columns` is a Postgrest column-list string. Default `"*"` — be specific
 * to keep payloads small.
 */
export async function fetchAllLeads<T = Record<string, unknown>>(
  filter: LeadFilter = {},
  columns: string = "*",
): Promise<{ rows: T[]; total: number; predicate: LeadFilter }> {
  const all: T[] = [];
  const PAGE = 1000;
  let cursor = 0;
  // Safety stop — we have ~3k leads today; 50k is 16x headroom.
  const MAX_ROWS = 50_000;
  while (cursor < MAX_ROWS) {
    let q = supabase.from("pipeline_leads").select(columns).order("created_at", { ascending: false });
    if (filter.repId !== undefined) q = q.eq("assigned_rep_id", filter.repId);
    if (filter.status) {
      if (Array.isArray(filter.status)) q = q.in("status", filter.status as readonly string[]);
      else q = q.eq("status", filter.status);
    }
    if (filter.tier) q = q.eq("lead_tier", filter.tier);
    if (filter.since) q = q.gte("created_at", filter.since);
    if (filter.until) q = q.lt("created_at", filter.until);
    if (filter.sentSince) q = q.gte("sent_at", filter.sentSince);
    if (filter.sentUntil) q = q.lt("sent_at", filter.sentUntil);
    const { data, error } = await q.range(cursor, cursor + PAGE - 1);
    if (error) throw new Error(`fetchAllLeads failed: ${error.message}`);
    if (!data || data.length === 0) break;
    all.push(...(data as T[]));
    if (data.length < PAGE) break;
    cursor += PAGE;
  }
  // Geo bucketing in JS (the only way — derived from author_email).
  let rows = all;
  if (filter.geo) {
    rows = rows.filter((r) => {
      const email = ((r as { author_email?: string | null }).author_email ?? "").toLowerCase();
      const isCn = email.endsWith(".cn") || email.endsWith(".edu.cn");
      const isEdu = email.endsWith(".edu") || email.endsWith(".ac") || email.endsWith(".edu.cn");
      if (filter.geo === "cn") return isCn;
      if (filter.geo === "edu") return isEdu && !isCn;
      if (filter.geo === "overseas") return !isCn && !isEdu;
      return true;
    });
  }
  return { rows, total: rows.length, predicate: filter };
}

// ── emails (outbound) ───────────────────────────────────────────────────

/**
 * Count outbound emails matching the filter.
 *
 * Note: `emails` uses `actor_rep_id` for attribution, NOT a column called
 * `rep_id`. The schema also has a `rep_id` column (historical, owner-ish)
 * but actor_rep_id is the audit-correct field for "who pressed send."
 * This module only ever filters by actor_rep_id.
 */
export async function countSent(
  filter: EmailFilter = {},
  opts?: Opts,
): Promise<{ count: number; predicate: EmailFilter }> {
  return memoize("countSent", filter, opts, async () => {
    let q = supabase.from("emails").select("*", { count: "exact", head: true });
    if (filter.actorRepId !== undefined) q = q.eq("actor_rep_id", filter.actorRepId);
    if (filter.status) {
      if (Array.isArray(filter.status)) q = q.in("status", filter.status as readonly string[]);
      else q = q.eq("status", filter.status);
    } else {
      // Default: REACHABLE means "we actually emailed them" — excludes
      // bounced + complained.
      q = q.in("status", REACHABLE_EMAIL_STATUSES as readonly string[]);
    }
    if (filter.since) q = q.gte("created_at", filter.since);
    if (filter.until) q = q.lt("created_at", filter.until);
    const { count, error } = await q;
    if (error) throw new Error(`countSent failed: ${error.message}`);
    return { count: count ?? 0, predicate: filter };
  });
}

// ── inbound_emails (replies) ────────────────────────────────────────────

/**
 * Count replies matching the filter.
 *
 * `repId` filters on inbound_emails.rep_id directly (canonical).
 * `threadIds` adds a fallback scope: any row whose thread_id is in the
 * list — covers legacy rows where rep_id is NULL. The two predicates are
 * OR'd together (matching the /api/inbound route's behavior).
 */
export async function countReplies(
  filter: ReplyFilter = {},
  opts?: Opts,
): Promise<{ count: number; unread: number; predicate: ReplyFilter }> {
  return memoize("countReplies", filter, opts, async () => {
    // Build the OR scope string once for postgrest .or()
    const buildScopedQuery = () => {
      let q = supabase.from("inbound_emails").select("*", { count: "exact", head: true });
      const orParts: string[] = [];
      if (filter.repId !== undefined) orParts.push(`rep_id.eq.${filter.repId}`);
      if (filter.threadIds && filter.threadIds.length > 0) {
        const safe = filter.threadIds.map((t) => `"${t}"`).join(",");
        orParts.push(`thread_id.in.(${safe})`);
      }
      if (orParts.length > 0) q = q.or(orParts.join(","));
      if (filter.since) q = q.gte("created_at", filter.since);
      return q;
    };
    const total = await (filter.isRead === undefined ? buildScopedQuery() : buildScopedQuery().eq("is_read", filter.isRead));
    const unread = await buildScopedQuery().eq("is_read", false);
    if (total.error) throw new Error(`countReplies(total) failed: ${total.error.message}`);
    if (unread.error) throw new Error(`countReplies(unread) failed: ${unread.error.message}`);
    return { count: total.count ?? 0, unread: unread.count ?? 0, predicate: filter };
  });
}

/**
 * Helper: resolve every thread_id this rep has sent on. Used to build
 * the `threadIds` arg to countReplies for rep-scoped reply counts where
 * the inbound row's rep_id might not be set (legacy).
 */
export async function getThreadIdsForRep(
  actorRepId: number,
  senderEmail: string | null,
  opts?: Opts,
): Promise<string[]> {
  return memoize("getThreadIdsForRep", { actorRepId, senderEmail }, opts, async () => {
    const orParts = [`actor_rep_id.eq.${actorRepId}`];
    if (senderEmail) orParts.push(`from.ilike.%${senderEmail}%`);
    const { data, error } = await supabase
      .from("emails")
      .select("thread_id")
      .or(orParts.join(","))
      .not("thread_id", "is", null);
    if (error) throw new Error(`getThreadIdsForRep failed: ${error.message}`);
    return Array.from(new Set((data ?? []).map((r) => r.thread_id as string).filter(Boolean)));
  });
}

// ── brief_lookups (wechat conversions) ──────────────────────────────────

/**
 * Count wechat conversions in brief_lookups (added_wechat = true).
 *
 * `markedByRepId` is who RECORDED the conversion (the closer who gets
 * credit). Not the lead's original assigned_rep_id.
 */
export async function countWechatConversions(
  filter: WechatFilter = {},
  opts?: Opts,
): Promise<{ count: number; predicate: WechatFilter }> {
  return memoize("countWechatConversions", filter, opts, async () => {
    let q = supabase
      .from("brief_lookups")
      .select("*", { count: "exact", head: true })
      .eq("added_wechat", true);
    if (filter.markedByRepId !== undefined) q = q.eq("marked_by_rep_id", filter.markedByRepId);
    if (filter.since) q = q.gte("looked_up_at", filter.since);
    if (filter.until) q = q.lt("looked_up_at", filter.until);
    const { count, error } = await q;
    if (error) throw new Error(`countWechatConversions failed: ${error.message}`);
    return { count: count ?? 0, predicate: filter };
  });
}

// ── Composite: ready-queue split (sendable today vs ripening) ───────────
//
// The pipeline UI shows "X ready to send today, Y ripening" — splits the
// `status='ready'` rows by whether they were created in the last 7 days
// (still ripening per the contact-guard cooldown) vs older (sendable).
// Pull both with one round-trip through countLeads.

export async function countReadyQueue(
  filter: Omit<LeadFilter, "status"> = {},
  opts?: Opts,
): Promise<{ sendable: number; ripening: number; total: number; predicate: Omit<LeadFilter, "status"> }> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const [total, ripening] = await Promise.all([
    countLeads({ ...filter, status: "ready" }, opts),
    countLeads({ ...filter, status: "ready", since: sevenDaysAgo }, opts),
  ]);
  return {
    sendable: total.count - ripening.count,
    ripening: ripening.count,
    total: total.count,
    predicate: filter,
  };
}
