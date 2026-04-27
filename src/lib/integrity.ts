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

export async function runIntegrity(): Promise<IntegrityReport> {
  const checks = await Promise.all([
    checkWebhookFreshness(),
    checkResendIdCoverage(),
    checkInboundRepCoverage(),
    checkWechatActorCoverage(),
    checkCronSyncRecency(),
    checkRepsHaveSenderEmail(),
  ]);
  const summary = {
    green: checks.filter((c) => c.status === "green").length,
    yellow: checks.filter((c) => c.status === "yellow").length,
    red: checks.filter((c) => c.status === "red").length,
  };
  return { ranAt: new Date().toISOString(), checks, summary };
}
