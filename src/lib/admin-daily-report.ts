/**
 * Builds the admin's daily org-wide report sent at 09:00 Beijing.
 *
 * One public export: buildAdminDailyReport(). Five sections fetched
 * in parallel; failure in any section renders "—" so a single broken
 * source doesn't blank the report.
 *
 * Output is plain text (Chinese) targeting Lark DM. Uses light markdown
 * (** **) which Lark renders as bold.
 *
 * Schema adaptations from plan:
 * - inbound_emails has no source_email_id — link via thread_id on emails
 * - brief_lookups has no wechat_followup_at — stale-wechat alert omitted
 * - integrity module is @/lib/integrity (not @/lib/integrity-checks)
 */

import { supabase } from "@/lib/db";
import { getMpConversionMatrix } from "@/lib/canonical-counts";

const VERBATIM_THRESHOLD = 5; // edit_distance ≤ 5 ≈ verbatim accept

function isoStartOfYesterday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}
function isoEndOfYesterday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  d.setUTCHours(23, 59, 59, 999);
  return d.toISOString();
}
function isoStartOfWeek(): string {
  // Monday 00:00 UTC. Treat Sunday as last day of prior week.
  const d = new Date();
  const day = d.getUTCDay(); // 0=Sun, 1=Mon..6=Sat
  const daysFromMonday = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - daysFromMonday);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}
function pct(num: number, denom: number): string {
  if (denom <= 0) return "—";
  return `${Math.round((num / denom) * 100)}%`;
}

interface OrgMetrics {
  sent: number;
  opened: number;
  clicked: number;
  replied: number;
  wechat: number;
  // MP CRM ground-truth conversion signals (from miracleplus_contacts +
  // brief_lookups), scoped to emails sent in this window.
  registered: number;
  submittedApplication: number;
}

async function fetchOrgMetrics(sinceIso: string, untilIso?: string): Promise<OrgMetrics> {
  // Sent
  let sent = 0;
  {
    let q = supabase.from("emails").select("id", { count: "exact", head: true }).gte("created_at", sinceIso);
    if (untilIso) q = q.lte("created_at", untilIso);
    const r = await q;
    sent = r.count ?? 0;
  }
  // Email IDs + thread_ids for opened/clicked/replied lookups
  let emailIds: string[] = [];
  let threadIds: string[] = [];
  {
    let q = supabase.from("emails").select("id, thread_id").gte("created_at", sinceIso);
    if (untilIso) q = q.lte("created_at", untilIso);
    const r = await q.limit(5000);
    emailIds = (r.data ?? []).map((e) => e.id as string);
    threadIds = (r.data ?? []).map((e) => e.thread_id as string).filter(Boolean);
  }
  let opened = 0, clicked = 0, replied = 0;
  if (emailIds.length > 0) {
    const o = await supabase
      .from("webhook_events")
      .select("email_id")
      .eq("type", "email.opened")
      .in("email_id", emailIds);
    opened = new Set((o.data ?? []).map((e) => e.email_id as string)).size;

    const c = await supabase
      .from("webhook_events")
      .select("email_id")
      .eq("type", "email.clicked")
      .in("email_id", emailIds);
    clicked = new Set((c.data ?? []).map((e) => e.email_id as string)).size;
  }
  // Replied: count inbound_emails whose thread_id matches an outbound email in the window
  if (threadIds.length > 0) {
    const rep = await supabase
      .from("inbound_emails")
      .select("id", { count: "exact", head: true })
      .in("thread_id", threadIds);
    replied = rep.count ?? 0;
  }
  // WeChat marks
  let wechat = 0;
  {
    let q = supabase.from("brief_lookups").select("id", { count: "exact", head: true }).eq("added_wechat", true).gte("wechat_at", sinceIso);
    if (untilIso) q = q.lte("wechat_at", untilIso);
    const r = await q;
    wechat = r.count ?? 0;
  }
  // MP CRM ground-truth conversions — registered + submittedApplication
  // across emails actually sent in the window. Non-fatal if it errors.
  let registered = 0;
  let submittedApplication = 0;
  try {
    const matrix = await getMpConversionMatrix({ since: sinceIso });
    registered = matrix.registered;
    submittedApplication = matrix.submittedApplication;
  } catch (e) {
    console.error("[admin-daily-report] fetchOrgMetrics/mp matrix failed:", e);
  }
  return { sent, opened, clicked, replied, wechat, registered, submittedApplication };
}

interface PerRepRow {
  rep_id: number;
  name: string;
  sent: number;
  opened: number;
  clicked: number;
  replied: number;
  wechat: number;
  // MP CRM conversions attributed to this rep's actor_rep_id, same window
  registered: number;
  submittedApplication: number;
}

async function fetchPerRepMetrics(sinceIso: string, untilIso: string): Promise<PerRepRow[]> {
  const reps = await supabase
    .from("sales_reps")
    .select("id, name, role")
    .eq("active", true)
    .neq("role", "admin")  // admins don't send; skip from per-rep table
    .order("id");
  if (!reps.data) return [];

  // Pull MP conversion matrix once for the whole window (perRep populated
  // because actorRepId is omitted). Cheaper than calling per-rep N times.
  const mpByRep = new Map<number, { registered: number; submittedApplication: number }>();
  try {
    const matrix = await getMpConversionMatrix({ since: sinceIso });
    for (const r of matrix.perRep ?? []) {
      mpByRep.set(r.rep_id, {
        registered: r.registered,
        submittedApplication: r.submittedApplication,
      });
    }
  } catch (e) {
    console.error("[admin-daily-report] fetchPerRepMetrics/mp matrix failed:", e);
  }

  const out: PerRepRow[] = [];
  for (const rep of reps.data) {
    const mp = mpByRep.get(rep.id as number);
    const emails = await supabase
      .from("emails")
      .select("id, thread_id")
      .eq("actor_rep_id", rep.id)
      .gte("created_at", sinceIso)
      .lte("created_at", untilIso)
      .limit(2000);
    const ids = (emails.data ?? []).map((e) => e.id as string);
    const threadIds = (emails.data ?? []).map((e) => e.thread_id as string).filter(Boolean);
    if (ids.length === 0) {
      out.push({
        rep_id: rep.id as number,
        name: rep.name as string,
        sent: 0,
        opened: 0,
        clicked: 0,
        replied: 0,
        wechat: 0,
        registered: mp?.registered ?? 0,
        submittedApplication: mp?.submittedApplication ?? 0,
      });
      continue;
    }
    const [o, c, w] = await Promise.all([
      supabase.from("webhook_events").select("email_id").eq("type", "email.opened").in("email_id", ids),
      supabase.from("webhook_events").select("email_id").eq("type", "email.clicked").in("email_id", ids),
      supabase.from("brief_lookups").select("id", { count: "exact", head: true })
        .eq("added_wechat", true).eq("marked_by_rep_id", rep.id)
        .gte("wechat_at", sinceIso).lte("wechat_at", untilIso),
    ]);
    // Replied: inbound_emails linked by thread_id
    let replied = 0;
    if (threadIds.length > 0) {
      const r = await supabase
        .from("inbound_emails")
        .select("id", { count: "exact", head: true })
        .in("thread_id", threadIds);
      replied = r.count ?? 0;
    }
    out.push({
      rep_id: rep.id as number,
      name: rep.name as string,
      sent: ids.length,
      opened: new Set((o.data ?? []).map((e) => e.email_id as string)).size,
      clicked: new Set((c.data ?? []).map((e) => e.email_id as string)).size,
      replied,
      wechat: w.count ?? 0,
      registered: mp?.registered ?? 0,
      submittedApplication: mp?.submittedApplication ?? 0,
    });
  }
  return out;
}

interface AiUsageRow {
  rep_id: number;
  name: string;
  sent: number;
  verbatim_pct: number;       // % of sends with edit_distance ≤ VERBATIM_THRESHOLD
  median_edit_distance: number;
  top_edit_reason: string | null;
}

async function fetchAiUsage(sinceIso: string): Promise<AiUsageRow[]> {
  const reps = await supabase
    .from("sales_reps")
    .select("id, name, role")
    .eq("active", true)
    .neq("role", "admin")
    .order("id");
  if (!reps.data) return [];
  const out: AiUsageRow[] = [];
  for (const rep of reps.data) {
    const r = await supabase
      .from("pipeline_leads")
      .select("draft_edit_distance, edit_reasons")
      .eq("status", "sent")
      .eq("assigned_rep_id", rep.id)
      .gte("sent_at", sinceIso)
      .limit(500);
    const rows = r.data ?? [];
    if (rows.length === 0) {
      out.push({ rep_id: rep.id as number, name: rep.name as string, sent: 0, verbatim_pct: 0, median_edit_distance: 0, top_edit_reason: null });
      continue;
    }
    const distances = rows.map((x) => (x.draft_edit_distance as number | null) ?? 0).sort((a, b) => a - b);
    const median = distances[Math.floor(distances.length / 2)];
    const verbatim = distances.filter((d) => d <= VERBATIM_THRESHOLD).length;
    // Top edit reason (across all rows' edit_reasons arrays)
    const reasonCounts = new Map<string, number>();
    for (const row of rows) {
      const reasons = (row.edit_reasons as string[] | null) ?? [];
      for (const reason of reasons) {
        reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
      }
    }
    let topReason: string | null = null;
    let topCount = 0;
    for (const [reason, count] of reasonCounts) {
      if (count > topCount) { topCount = count; topReason = reason; }
    }
    out.push({
      rep_id: rep.id as number,
      name: rep.name as string,
      sent: rows.length,
      verbatim_pct: Math.round((verbatim / rows.length) * 100),
      median_edit_distance: median,
      top_edit_reason: topReason,
    });
  }
  return out;
}

interface AlertRow { kind: string; text: string; }

async function fetchAlerts(): Promise<AlertRow[]> {
  const alerts: AlertRow[] = [];
  // Quota vs pool warnings
  try {
    const quotas = await supabase.from("rep_daily_quotas").select("rep_id, per_pool");
    const reps = await supabase.from("sales_reps").select("id, name").eq("active", true);
    const nameById = new Map((reps.data ?? []).map((r) => [r.id, r.name as string]));
    const pools: Record<string, number> = {};
    for (const pk of ["strong", "normal_cn", "normal_overseas", "normal_edu"]) {
      const r = await supabase.from("v_lead_pool").select("id", { count: "exact", head: true }).eq("pool_key", pk);
      pools[pk] = r.count ?? 0;
    }
    for (const q of quotas.data ?? []) {
      const pp = (q.per_pool as Record<string, number>) ?? {};
      for (const [pk, want] of Object.entries(pp)) {
        if (want > 0 && pools[pk] < want) {
          alerts.push({
            kind: "underfill",
            text: `${nameById.get(q.rep_id as number) ?? `rep#${q.rep_id}`} 今天 ${pk} quota=${want} 但 pool 只有 ${pools[pk]}`,
          });
        }
      }
    }
  } catch (e) { console.error("[admin-daily-report] alerts/quota failed:", e); }
  // Integrity report — reuse the integrity lib if available
  try {
    const { runIntegrity } = await import("@/lib/integrity");
    const report = await runIntegrity();
    const red = (report as { red?: unknown[] }).red?.length ?? 0;
    if (red > 0) alerts.push({ kind: "integrity_red", text: `集成检查 ${red} 个 red — 用 get_integrity_report 看详情` });
    else alerts.push({ kind: "integrity_ok", text: `✅ 集成检查全部通过` });
  } catch {
    // integrity check is optional — silent miss
  }
  return alerts;
}

function renderMessage(input: {
  orgYesterday: OrgMetrics;
  orgWeek: OrgMetrics;
  perRepYesterday: PerRepRow[];
  aiUsageWeek: AiUsageRow[];
  alerts: AlertRow[];
}): string {
  const lines: string[] = [];
  lines.push(`📊 早安 — 今日 admin report`);
  lines.push(``);
  const y = input.orgYesterday;
  lines.push(`**昨天 (org-wide)**`);
  lines.push(`  发送: ${y.sent} 封 · 打开: ${y.opened} (${pct(y.opened, y.sent)}) · 点击: ${y.clicked} (${pct(y.clicked, y.sent)}) · 回复: ${y.replied} (${pct(y.replied, y.sent)})`);
  lines.push(`  微信新加: ${y.wechat}`);
  lines.push(`  注册: ${y.registered} · 开表: ${y.submittedApplication}`);
  lines.push(``);
  const w = input.orgWeek;
  lines.push(`**本周累计 (周一 → 今天)**`);
  lines.push(`  发送: ${w.sent} 封 · 打开: ${w.opened} (${pct(w.opened, w.sent)}) · 点击: ${w.clicked} (${pct(w.clicked, w.sent)}) · 回复: ${w.replied} (${pct(w.replied, w.sent)})`);
  lines.push(`  微信新加: ${w.wechat}`);
  lines.push(`  注册: ${w.registered} · 开表: ${w.submittedApplication}`);
  lines.push(``);
  if (input.perRepYesterday.length > 0) {
    lines.push(`**按 rep 看 (昨天)**`);
    for (const r of input.perRepYesterday) {
      if (r.sent === 0 && r.registered === 0 && r.submittedApplication === 0) {
        lines.push(`  ${r.name.padEnd(8)} 0 发`);
        continue;
      }
      const wxMark = r.wechat > 0 ? ` · ${r.wechat} wx ✓` : "";
      const mpMark = (r.registered > 0 || r.submittedApplication > 0)
        ? ` · 注册: ${r.registered} · 开表: ${r.submittedApplication}`
        : "";
      lines.push(`  ${r.name.padEnd(8)} ${r.sent} 发, ${r.opened} 开 (${pct(r.opened, r.sent)}), ${r.clicked} 点 (${pct(r.clicked, r.sent)}), ${r.replied} 回${wxMark}${mpMark}`);
    }
    lines.push(``);
  }
  if (input.aiUsageWeek.some((r) => r.sent > 0)) {
    lines.push(`**reps 怎么用 AI (本周)**`);
    for (const r of input.aiUsageWeek) {
      if (r.sent === 0) continue;
      const reasonPart = r.top_edit_reason ? ` · 主要原因 "${r.top_edit_reason}"` : "";
      lines.push(`  ${r.name.padEnd(8)} 逐字接受 ${r.verbatim_pct}% · 中位编辑距离 ${r.median_edit_distance} 字${reasonPart}`);
    }
    lines.push(``);
  }
  lines.push(`**需要你注意**`);
  if (input.alerts.length === 0) {
    lines.push(`  ✅ 没看到需要立刻处理的`);
  } else {
    for (const a of input.alerts) {
      const prefix = a.kind === "integrity_ok" ? "" : "⚠️ ";
      lines.push(`  ${prefix}${a.text}`);
    }
  }
  lines.push(``);
  lines.push(`**有什么要我做** — DM 我就行, 例如:`);
  lines.push(`  • "把 Jinyang 今天的 overseas lead 转给 Ethan"`);
  lines.push(`  • "今天的 strong lead 全部 redraft 一遍"`);
  lines.push(`  • "你今天做了什么"  → 我会列出今天帮你做过的操作`);
  return lines.join("\n");
}

export async function buildAdminDailyReport(): Promise<string> {
  const yStart = isoStartOfYesterday();
  const yEnd = isoEndOfYesterday();
  const wStart = isoStartOfWeek();
  const nowIso = new Date().toISOString();
  // Each section caught — failure renders empty/placeholder, doesn't blank the whole report
  const [orgYesterday, orgWeek, perRepYesterday, aiUsageWeek, alerts] = await Promise.all([
    fetchOrgMetrics(yStart, yEnd).catch((e) => { console.error("[admin-daily-report] org/yesterday:", e); return { sent: 0, opened: 0, clicked: 0, replied: 0, wechat: 0, registered: 0, submittedApplication: 0 }; }),
    fetchOrgMetrics(wStart, nowIso).catch((e) => { console.error("[admin-daily-report] org/week:", e); return { sent: 0, opened: 0, clicked: 0, replied: 0, wechat: 0, registered: 0, submittedApplication: 0 }; }),
    fetchPerRepMetrics(yStart, yEnd).catch((e) => { console.error("[admin-daily-report] per-rep:", e); return []; }),
    fetchAiUsage(wStart).catch((e) => { console.error("[admin-daily-report] ai-usage:", e); return []; }),
    fetchAlerts().catch((e) => { console.error("[admin-daily-report] alerts:", e); return []; }),
  ]);
  return renderMessage({ orgYesterday, orgWeek, perRepYesterday, aiUsageWeek, alerts });
}
