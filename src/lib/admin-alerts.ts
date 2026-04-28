// Admin proactive alerts — derived live, no new schema. Runs in
// `get_admin_alerts` read tool so the helper can open admin's panel
// with "today's worth-knowing" instead of a blank prompt.
//
// Each alert has a stable `kind` so the helper (and a future digest
// email) can dedupe and rank. Severity is just for ordering display.

import { supabase } from "@/lib/db";
import { CONTACTED_LEAD_STATUSES } from "@/lib/status";
import { getStaleWechatFollowups } from "@/lib/wechat-followup";
import { detectQuestionClusters } from "@/lib/helper-question-clusters";

export type AlertKind =
  | "drift_pending"
  | "rep_idle"
  | "click_rate_drop"
  | "model_undertrained"
  | "wechat_attribution_gap"
  | "stale_wechat_followups"
  | "shared_helper_questions";
export type Severity = "info" | "warn" | "high";

export interface Alert {
  kind: AlertKind;
  severity: Severity;
  headline: string;
  evidence: Record<string, unknown>;
  action_hint: string;
}

const REP_IDLE_DAYS = 4;
const CLICK_DROP_THRESHOLD = 0.4;  // current week / prior week ratio

function dayStartUtc(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString();
}

async function checkDriftPending(): Promise<Alert | null> {
  // Patterns waiting on admin review.
  const { count } = await supabase
    .from("prompt_drift_patterns")
    .select("*", { count: "exact", head: true })
    .eq("status", "pending");
  if (!count || count === 0) return null;
  return {
    kind: "drift_pending",
    severity: count >= 5 ? "warn" : "info",
    headline: `${count} drift pattern${count === 1 ? "" : "s"} pending review at /drift`,
    evidence: { pending_count: count },
    action_hint: "Open /drift, accept or ignore each — accepted patches feed into the next day's prompt.",
  };
}

async function checkRepIdle(): Promise<Alert[]> {
  // Active sales reps who haven't sent anything in REP_IDLE_DAYS days.
  const { data: reps } = await supabase
    .from("sales_reps")
    .select("id, sender_name, name")
    .eq("active", true)
    .eq("role", "sales");
  if (!reps || reps.length === 0) return [];
  const since = dayStartUtc(REP_IDLE_DAYS);
  const out: Alert[] = [];
  for (const r of reps) {
    const { count } = await supabase
      .from("pipeline_leads")
      .select("*", { count: "exact", head: true })
      .eq("assigned_rep_id", r.id)
      .in("status", [...CONTACTED_LEAD_STATUSES])
      .gte("sent_at", since);
    if (count === 0) {
      const display = (r.sender_name as string) || (r.name as string) || `rep #${r.id}`;
      out.push({
        kind: "rep_idle",
        severity: "warn",
        headline: `${display} hasn't sent anything in ${REP_IDLE_DAYS} days`,
        evidence: { rep_id: r.id, days_idle: REP_IDLE_DAYS },
        action_hint: `Check in — they may be blocked, on leave, or lacking ready leads. /metrics?rep=${r.id}`,
      });
    }
  }
  return out;
}

async function checkClickRateDrop(): Promise<Alert | null> {
  // Compare last-7-days vs previous-7-days clicked-rate. Cheap proxy:
  // count emails with status='clicked' in each window over total
  // contacted in the same window.
  const now = Date.now();
  const wk = 7 * 86_400_000;
  const cur = new Date(now - wk).toISOString();
  const prev = new Date(now - 2 * wk).toISOString();
  // Tier 2: read clicked counts from email_history (canonical event log
  // join), not emails.status — the latter undercounts when a click is
  // overwritten by a later complaint/bounce.
  const [curC, curT, prevC, prevT] = await Promise.all([
    supabase.from("email_history").select("*", { count: "exact", head: true }).eq("was_clicked", true).gte("created_at", cur),
    supabase.from("emails").select("*", { count: "exact", head: true }).gte("created_at", cur),
    supabase.from("email_history").select("*", { count: "exact", head: true }).eq("was_clicked", true).gte("created_at", prev).lt("created_at", cur),
    supabase.from("emails").select("*", { count: "exact", head: true }).gte("created_at", prev).lt("created_at", cur),
  ]);
  const curRate = (curT.count ?? 0) > 0 ? (curC.count ?? 0) / (curT.count ?? 1) : 0;
  const prevRate = (prevT.count ?? 0) > 0 ? (prevC.count ?? 0) / (prevT.count ?? 1) : 0;
  if (prevRate < 0.02 || (curT.count ?? 0) < 20) return null;  // not enough volume to claim a drop
  const ratio = curRate / prevRate;
  if (ratio >= 1 - CLICK_DROP_THRESHOLD) return null;
  return {
    kind: "click_rate_drop",
    severity: "high",
    headline: `Click rate dropped from ${(prevRate * 100).toFixed(1)}% to ${(curRate * 100).toFixed(1)}% week-over-week`,
    evidence: {
      current_week: { clicked: curC.count, total: curT.count, rate: curRate },
      prior_week: { clicked: prevC.count, total: prevT.count, rate: prevRate },
      ratio: Math.round(ratio * 100) / 100,
    },
    action_hint: "Look at recent drafts — drift miner output, recipient quality, or a deliverability change.",
  };
}

async function checkModelUndertrained(): Promise<Alert | null> {
  // Read the last-trained conversion model and warn if positive class is tiny.
  const { data: row } = await supabase
    .from("system_config")
    .select("value")
    .eq("key", "active_conversion_model")
    .maybeSingle();
  const model = row?.value as { label_stats?: { either: number } } | null;
  const positives = model?.label_stats?.either;
  if (typeof positives !== "number" || positives >= 20) return null;
  return {
    kind: "model_undertrained",
    severity: "info",
    headline: `Conversion model trained on only ${positives} positive samples — predictions are directional only`,
    evidence: { positive_samples: positives },
    action_hint: "Wait for more WeChat conversions / clicks to accumulate, then retrain at /scorer.",
  };
}

async function checkWechatAttributionGap(): Promise<Alert | null> {
  // Count WeChat conversions where marked_by_rep_id is null. Pre-migration
  // 012 rows; post-migration this should stay at 0.
  const { count } = await supabase
    .from("brief_lookups")
    .select("*", { count: "exact", head: true })
    .eq("added_wechat", true)
    .is("marked_by_rep_id", null);
  if (!count || count === 0) return null;
  return {
    kind: "wechat_attribution_gap",
    severity: "info",
    headline: `${count} WeChat conversions with no actor attribution (pre-migration-012 backfill)`,
    evidence: { unattributed_count: count },
    action_hint: "If you remember who marked them, manually attribute via the brief panel. Otherwise leave as-is — they still count org-wide.",
  };
}

async function checkSharedHelperQuestions(): Promise<Alert[]> {
  // When ≥2 reps ask the helper-bot about the same topic, surface it as
  // a doc/UI gap admin should fix. Each cluster becomes one alert; we
  // cap to top 3 so the opener doesn't get spammy.
  const clusters = await detectQuestionClusters();
  if (clusters.length === 0) return [];
  return clusters.slice(0, 3).map((c) => ({
    kind: "shared_helper_questions" as const,
    severity: c.rep_ids.length >= 3 ? "warn" : "info",
    headline: `${c.rep_ids.length} reps asked the helper about "${c.topic}" — likely a docs/tool gap`,
    evidence: {
      rep_ids: c.rep_ids,
      example_quotes: c.example_quotes,
      message_count: c.count,
      most_recent_days_ago: c.recency_days,
    },
    action_hint: "Update the Sales Guide or add a tool/UI affordance so reps don't have to ask.",
  }));
}

async function checkStaleWechatFollowups(): Promise<Alert | null> {
  // Org-wide: any rep with WeChat marks ≥3 days old and no inbound since.
  const stale = await getStaleWechatFollowups(null);
  if (stale.length === 0) return null;
  const oldest = stale.reduce((a, b) => (a.days_stale > b.days_stale ? a : b));
  return {
    kind: "stale_wechat_followups",
    severity: stale.length >= 5 ? "warn" : "info",
    headline: `${stale.length} WeChat conversion${stale.length === 1 ? "" : "s"} ≥3 days old without a reply (oldest: ${oldest.days_stale}d, ${oldest.recipient ?? "unknown"})`,
    evidence: { count: stale.length, oldest_days: oldest.days_stale },
    action_hint: "Each rep's helper will surface their own stale follow-ups on next session-open.",
  };
}

export async function getAdminAlerts(): Promise<{ alerts: Alert[] }> {
  const [drift, idle, clickDrop, modelUnder, wechatGap, staleWechat, sharedQs] = await Promise.all([
    checkDriftPending(),
    checkRepIdle(),
    checkClickRateDrop(),
    checkModelUndertrained(),
    checkWechatAttributionGap(),
    checkStaleWechatFollowups(),
    checkSharedHelperQuestions(),
  ]);
  const alerts: Alert[] = [];
  if (drift) alerts.push(drift);
  alerts.push(...idle);
  if (clickDrop) alerts.push(clickDrop);
  if (modelUnder) alerts.push(modelUnder);
  if (wechatGap) alerts.push(wechatGap);
  if (staleWechat) alerts.push(staleWechat);
  alerts.push(...sharedQs);
  // Order: high → warn → info, then by kind for stability.
  const sevRank: Record<Severity, number> = { high: 0, warn: 1, info: 2 };
  alerts.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || a.kind.localeCompare(b.kind));
  return { alerts };
}
