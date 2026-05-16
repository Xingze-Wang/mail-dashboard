// Tier 6 of docs/DATA_INTEGRITY_PLAN.md.
//
// Server-side mirror of scripts/integrity.mjs. Same invariants, same
// thresholds — the script is for terminal/CI; this is what cron calls
// daily and what /api/integrity exposes for the admin dashboard tile.
//
// Keep both in sync. If you change a threshold here, change it there.
// (Worth duplicating because the script must run with zero deps for
// CI; the route version uses our shared supabase client.)

import { supabase } from "@/lib/db";

export type Severity = "green" | "yellow" | "red";

export interface IntegrityCheck {
  name: string;
  status: Severity;
  detail: string;
}

export interface IntegrityReport {
  ranAt: string;
  checks: IntegrityCheck[];
  summary: { green: number; yellow: number; red: number };
}

async function checkWebhookFreshness(): Promise<IntegrityCheck> {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const [{ count: events }, { count: sent }] = await Promise.all([
    supabase.from("webhook_events").select("*", { count: "exact", head: true }).gte("created_at", dayAgo),
    supabase.from("emails").select("*", { count: "exact", head: true }).gte("created_at", dayAgo),
  ]);
  if ((sent ?? 0) === 0) {
    return { name: "webhook freshness", status: "yellow", detail: `no emails sent in last 24h (${events ?? 0} events received)` };
  }
  if ((events ?? 0) === 0) {
    return { name: "webhook freshness", status: "red", detail: `${sent} emails sent in last 24h but 0 webhook events received — webhook is broken` };
  }
  return { name: "webhook freshness", status: "green", detail: `${events} events / ${sent} sent in last 24h` };
}

async function checkResendIdCoverage(): Promise<IntegrityCheck> {
  const [{ count: total }, { count: missing }] = await Promise.all([
    supabase.from("emails").select("*", { count: "exact", head: true }),
    supabase.from("emails").select("*", { count: "exact", head: true }).is("resend_id", null),
  ]);
  if ((total ?? 0) === 0) {
    return { name: "emails.resend_id coverage", status: "yellow", detail: "no emails to check" };
  }
  const m = missing ?? 0;
  if (m === 0) return { name: "emails.resend_id coverage", status: "green", detail: `${total}/${total} have resend_id` };
  if (m / (total as number) < 0.01) return { name: "emails.resend_id coverage", status: "yellow", detail: `${m}/${total} missing (<1%)` };
  return { name: "emails.resend_id coverage", status: "red", detail: `${m}/${total} missing (>1%)` };
}

async function checkInboundRepCoverage(): Promise<IntegrityCheck> {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const [{ count: total }, { count: missing }] = await Promise.all([
    supabase.from("inbound_emails").select("*", { count: "exact", head: true }).gte("created_at", cutoff),
    supabase.from("inbound_emails").select("*", { count: "exact", head: true }).gte("created_at", cutoff).is("rep_id", null),
  ]);
  if ((total ?? 0) === 0) {
    return { name: "inbound.rep_id coverage (30d)", status: "yellow", detail: "no inbound in last 30d" };
  }
  const m = missing ?? 0;
  if (m === 0) return { name: "inbound.rep_id coverage (30d)", status: "green", detail: `${total}/${total} attributed` };
  if (m / (total as number) < 0.05) return { name: "inbound.rep_id coverage (30d)", status: "yellow", detail: `${m}/${total} missing` };
  return { name: "inbound.rep_id coverage (30d)", status: "red", detail: `${m}/${total} missing (>5%)` };
}

async function checkWechatActorCoverage(): Promise<IntegrityCheck> {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("brief_lookups")
    .select("id, marked_by_rep_id, wechat_at")
    .gte("wechat_at", cutoff)
    .eq("added_wechat", true);
  if (error) return { name: "wechat marks have actor (30d)", status: "yellow", detail: `query failed: ${error.message}` };
  const total = (data ?? []).length;
  const missing = (data ?? []).filter((r) => r.marked_by_rep_id == null).length;
  if (total === 0) return { name: "wechat marks have actor (30d)", status: "yellow", detail: "no wechat marks in last 30d" };
  if (missing === 0) return { name: "wechat marks have actor (30d)", status: "green", detail: `${total}/${total} attributed` };
  if (missing / total < 0.05) return { name: "wechat marks have actor (30d)", status: "yellow", detail: `${missing}/${total} missing actor` };
  return { name: "wechat marks have actor (30d)", status: "red", detail: `${missing}/${total} missing actor (>5%)` };
}

async function checkCronSyncRecency(): Promise<IntegrityCheck> {
  const day36Ago = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
  const [{ count: recentlyUpdated }, { count: recentlyCreated }] = await Promise.all([
    supabase.from("emails").select("*", { count: "exact", head: true }).gte("updated_at", day36Ago),
    supabase.from("emails").select("*", { count: "exact", head: true }).gte("created_at", day36Ago),
  ]);
  if ((recentlyUpdated ?? 0) > 0) {
    return { name: "cron sync recency", status: "green", detail: `${recentlyUpdated} emails updated in last 36h` };
  }
  if ((recentlyCreated ?? 0) === 0) {
    return { name: "cron sync recency", status: "yellow", detail: "no activity in last 36h (quiet period)" };
  }
  return {
    name: "cron sync recency",
    status: "red",
    detail: `${recentlyCreated} emails created in last 36h but 0 updates — cron sync isn't running`,
  };
}

async function checkRepsHaveSenderEmail(): Promise<IntegrityCheck> {
  const { data, error } = await supabase.from("sales_reps").select("id, name, sender_email, active");
  if (error) return { name: "active reps have sender_email", status: "yellow", detail: `query failed: ${error.message}` };
  const active = (data ?? []).filter((r) => r.active !== false);
  const missing = active.filter((r) => !r.sender_email);
  if (active.length === 0) return { name: "active reps have sender_email", status: "yellow", detail: "no active reps" };
  if (missing.length === 0) return { name: "active reps have sender_email", status: "green", detail: `${active.length}/${active.length} ok` };
  return {
    name: "active reps have sender_email",
    status: "red",
    detail: `${missing.length} missing: ${missing.map((r) => r.name).join(", ")}`,
  };
}

/**
 * MP sync recency — max(last_seen_at) across miracleplus_contacts.
 * Thresholds: green if <=36h old, yellow if <=72h, red beyond. This is
 * the canary for the daily /api/cron/sync-miracleplus-contacts cron.
 * If the staging API token rotates or the cron silently fails, the
 * mirror freezes and our funnel numbers drift without warning. This
 * check makes the freeze visible on the admin dashboard within hours.
 */
async function checkMpSyncRecency(): Promise<IntegrityCheck> {
  const name = "miracleplus sync recency";
  try {
    const { data, error } = await supabase
      .from("miracleplus_contacts")
      .select("last_seen_at")
      .order("last_seen_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return { name, status: "yellow", detail: `query failed: ${error.message}` };
    const ts = (data?.last_seen_at as string | null) ?? null;
    if (!ts) {
      return { name, status: "yellow", detail: "no miracleplus_contacts rows yet" };
    }
    const ageMs = Date.now() - new Date(ts).getTime();
    const ageH = Math.round(ageMs / (60 * 60 * 1000));
    if (ageMs <= 36 * 60 * 60 * 1000) {
      return { name, status: "green", detail: `last sync ${ageH}h ago (<=36h)` };
    }
    if (ageMs <= 72 * 60 * 60 * 1000) {
      return { name, status: "yellow", detail: `last sync ${ageH}h ago (36-72h)` };
    }
    return { name, status: "red", detail: `last sync ${ageH}h ago (>72h — cron likely broken)` };
  } catch (err) {
    return {
      name,
      status: "yellow",
      detail: `check threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * MP sync coverage — of the distinct recipients we actually emailed in
 * the last 7 days, how many have a miracleplus_contacts row mirrored?
 * This catches a different failure mode than recency: the cron CAN
 * run successfully but match 0% of recipients (API quota exhausted,
 * permission error swallowed, all calls returning empty). Without this
 * coverage check, the conversion matrix silently undercounts.
 *
 * Thresholds: we expect SOME match rate on emailed contacts. If
 * coverage drops below 5% with N>=20 emails sent, that's red — the
 * mirror is effectively dead even if rows look fresh. Green if >=15%,
 * yellow in between. Numbers are deliberately conservative: most
 * recipients are NOT in MP (they're cold prospects), so a 15% match
 * is actually healthy.
 */
async function checkMpSyncCoverage(): Promise<IntegrityCheck> {
  const name = "miracleplus sync coverage (7d emailed)";
  try {
    const sinceIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // Distinct emailed recipients in last 7d. Paginated to bound cost.
    const recipients = new Set<string>();
    const PAGE = 1000;
    let cursor = 0;
    const MAX_PAGES = 5; // ~5000 distinct recipients ceiling — plenty
    for (let i = 0; i < MAX_PAGES; i++) {
      const { data, error } = await supabase
        .from("emails")
        .select("to")
        .gte("created_at", sinceIso)
        .range(cursor, cursor + PAGE - 1);
      if (error) return { name, status: "yellow", detail: `emails query failed: ${error.message}` };
      if (!data || data.length === 0) break;
      for (const r of data) {
        const e = ((r as { to: string | null }).to ?? "").trim().toLowerCase();
        if (e && e.includes("@")) recipients.add(e);
      }
      if (data.length < PAGE) break;
      cursor += PAGE;
    }
    const N = recipients.size;
    if (N === 0) {
      return { name, status: "yellow", detail: "no emails sent in last 7d" };
    }

    // How many of those have a mirrored MP row at all?
    let matched = 0;
    const emails = Array.from(recipients);
    const BATCH = 500;
    for (let i = 0; i < emails.length; i += BATCH) {
      const slice = emails.slice(i, i + BATCH);
      const { data, error } = await supabase
        .from("miracleplus_contacts")
        .select("email_canonical")
        .in("email_canonical", slice);
      if (error) {
        return { name, status: "yellow", detail: `mp query failed: ${error.message}` };
      }
      const seen = new Set<string>();
      for (const r of (data ?? []) as { email_canonical: string | null }[]) {
        if (r.email_canonical) seen.add(r.email_canonical);
      }
      matched += seen.size;
    }
    const pct = (matched / N) * 100;
    const detail = `${matched}/${N} (${pct.toFixed(1)}%) mirrored`;
    if (N < 20) {
      // Sample too small to be definitive — treat as informational.
      return { name, status: "yellow", detail: `${detail} (sample <20)` };
    }
    if (pct >= 15) return { name, status: "green", detail };
    if (pct >= 5) return { name, status: "yellow", detail };
    return { name, status: "red", detail: `${detail} — mirror likely broken` };
  } catch (err) {
    return {
      name,
      status: "yellow",
      detail: `check threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function runIntegrity(): Promise<IntegrityReport> {
  const checks = await Promise.all([
    checkWebhookFreshness(),
    checkResendIdCoverage(),
    checkInboundRepCoverage(),
    checkWechatActorCoverage(),
    checkCronSyncRecency(),
    checkRepsHaveSenderEmail(),
    checkMpSyncRecency(),
    checkMpSyncCoverage(),
  ]);
  const summary = {
    green: checks.filter((c) => c.status === "green").length,
    yellow: checks.filter((c) => c.status === "yellow").length,
    red: checks.filter((c) => c.status === "red").length,
  };
  return { ranAt: new Date().toISOString(), checks, summary };
}
