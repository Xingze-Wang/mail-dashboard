"use client";

import { useEffect, useState } from "react";
import { useLocale, t } from "@/lib/i18n";
import {
  Send,
  CheckCircle2,
  MousePointerClick,
  AlertTriangle,
  Inbox,
  TrendingUp,
  MessageCircle,
} from "lucide-react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

interface Metrics {
  overview: {
    totalSent: number;
    totalDelivered: number;
    totalClicked: number;
    totalBounced: number;
    totalComplained: number;
    totalInbound: number;
    last7DaysSent: number;
    deliveryRate: string;
    clickRate: string;
    bounceRate: string;
  };
  pipeline: {
    ready: number;
    sent: number;
    total: number;
  };
  wechat: {
    total: number;
    recent: { query: string; arxivId: string; createdAt: string }[];
  };
  dailyStats: { date: string; sent: number; delivered: number; clicked: number; bounced: number }[];
  recentEvents: { id: string; type: string; createdAt: string; to?: string; subject?: string }[];
}

const CHART_TOOLTIP = {
  backgroundColor: "#FFFFFF",
  border: "1px solid var(--border)",
  borderRadius: 8,
  fontSize: 12,
  color: "#1A1A1A",
  boxShadow: "0 4px 12px rgba(0,0,0,0.06)",
};

// Built inside component so labels react to locale.

interface MyMetrics {
  repId: number;
  repName: string;
  assigned: number;
  ready: number;
  sent: number;
  replied: number;
  wechat: number;
  leadRate: string;
}

export default function OverviewPage() {
  const locale = useLocale();
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [me, setMe] = useState<{ repId: number; repName: string; role: "admin" | "sales" } | null>(null);
  const [myMetrics, setMyMetrics] = useState<MyMetrics | null>(null);
  const [loading, setLoading] = useState(true);

  const statCards = [
    { key: "totalSent",      label: t("stat.sent",      locale), icon: Send,             color: "var(--blue)"   },
    { key: "totalDelivered", label: t("stat.delivered", locale), icon: CheckCircle2,     color: "var(--green)"  },
    { key: "totalClicked",   label: t("stat.clicked",   locale), icon: MousePointerClick,color: "var(--purple)" },
    { key: "totalBounced",   label: t("stat.bounced",   locale), icon: AlertTriangle,    color: "var(--coral)"  },
    { key: "totalInbound",   label: t("stat.received",  locale), icon: Inbox,            color: "var(--blue)"   },
    { key: "wechatTotal",    label: t("stat.wechat",    locale), icon: MessageCircle,    color: "var(--green)"  },
  ];

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        if (d.authenticated) {
          setMe({ repId: d.repId, repName: d.repName, role: d.role === "admin" ? "admin" : "sales" });
        }
      })
      .catch(() => {});
  }, []);

  // Sales reps (excluding Leo who owns the historical global data) get a
  // scoped per-rep view from /api/metrics/me.
  const showPerRepOnly = me && me.role !== "admin" && me.repId !== 1;

  useEffect(() => {
    if (!showPerRepOnly) return;
    // Fetch both endpoints in parallel — /api/metrics/me gives the
    // per-rep pipeline counters, /api/metrics gives the funnel chart
    // (already scoped to this rep via the `from ilike sender_email`
    // server-side filter). Sales overview now mirrors the admin
    // layout with the same chart, just populated with their numbers.
    Promise.allSettled([
      fetch("/api/metrics/me").then((r) => r.json()),
      fetch("/api/metrics").then((r) => r.json()),
    ])
      .then(([meRes, metricsRes]) => {
        if (meRes.status === "fulfilled" && !meRes.value?.error) setMyMetrics(meRes.value);
        if (metricsRes.status === "fulfilled" && !metricsRes.value?.error) setMetrics(metricsRes.value);
      })
      .finally(() => setLoading(false));

    // Sync loop for sales. Each /api/sync call paginates Resend (~8s
    // budget), and each /api/metrics/me also hits getResendFunnel
    // server-side. Without bounds the loop costs ~80s of Resend traffic
    // per page mount and can blow the 5rps team-wide quota.
    //
    // Two guards:
    //   1. localStorage cooldown — at most once per 5 minutes per user.
    //      Hot-reload during dev was the worst offender; this kills it.
    //   2. iter cap dropped from 10 → 3. Real backlog rarely needs more;
    //      remaining drift gets caught by the daily 6-AM cron.
    let cancelled = false;
    const COOLDOWN_MS = 5 * 60 * 1000;
    const lastKey = "overview-sync-last-ms";
    const lastRun = Number(localStorage.getItem(lastKey) || "0");
    const skip = Date.now() - lastRun < COOLDOWN_MS;
    const runSync = async () => {
      if (skip) return;
      localStorage.setItem(lastKey, String(Date.now()));
      try {
        let complete = false;
        let iter = 0;
        while (!complete && !cancelled && iter < 3) {
          const res = await fetch("/api/sync");
          const data = await res.json();
          complete = data.complete !== false;
          const [meRes, metricsRes] = await Promise.all([
            fetch("/api/metrics/me").then((r) => r.json()),
            fetch("/api/metrics").then((r) => r.json()),
          ]);
          if (!cancelled) {
            if (meRes && !meRes.error) setMyMetrics(meRes);
            if (metricsRes && !metricsRes.error) setMetrics(metricsRes);
          }
          if (!complete) await new Promise((r) => setTimeout(r, 500));
          iter++;
        }
      } catch {
        // non-fatal — initial fetch already populated the cards.
      }
    };
    runSync();
    return () => { cancelled = true; };
  }, [showPerRepOnly]);

  useEffect(() => {
    // Admin/global view fetches /api/metrics with runSync loop.
    // Sales path above handles its own loading.
    if (me === null) return; // still loading session
    if (showPerRepOnly) return;

    fetch("/api/metrics")
      .then((res) => res.json())
      .then(setMetrics)
      .catch(console.error)
      .finally(() => setLoading(false));

    // Same guard as the sales-path loop above: 5min cooldown via
    // localStorage + iter cap of 3. Previously 10 iterations × Resend
    // pagination = up to 80s of background work per page mount.
    let cancelled = false;
    const COOLDOWN_MS = 5 * 60 * 1000;
    const lastKey = "overview-admin-sync-last-ms";
    const lastRun = Number(localStorage.getItem(lastKey) || "0");
    const skip = Date.now() - lastRun < COOLDOWN_MS;
    const runSync = async () => {
      if (skip) return;
      localStorage.setItem(lastKey, String(Date.now()));
      try {
        let complete = false;
        let iter = 0;
        while (!complete && !cancelled && iter < 3) {
          const res = await fetch("/api/sync");
          const data = await res.json();
          complete = data.complete !== false;
          const metricsRes = await fetch("/api/metrics");
          const metricsData = await metricsRes.json();
          if (metricsData && !cancelled) setMetrics(metricsData);
          if (!complete) await new Promise((r) => setTimeout(r, 500));
          iter++;
        }
      } catch {
        // non-fatal
      }
    };
    runSync();
    return () => { cancelled = true; };
  }, [me, showPerRepOnly]);

  if (loading) {
    return (
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28 }}>
          <h1 className="page-title">{t("overview.title", locale)}</h1>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 16, marginBottom: 24 }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="skeleton" style={{ height: 92 }} />
          ))}
        </div>
        <div className="skeleton" style={{ height: 320 }} />
      </div>
    );
  }

  // Sales rep branch must be checked BEFORE `!metrics` — sales never
  // fetches /api/metrics (the global funnel), so `metrics` will be
  // null for them. Without this reordering, sales users hit the
  // "Failed to load metrics" screen even though their per-rep view
  // (which depends only on myMetrics) is ready.
  if (showPerRepOnly) {
    const m = myMetrics;
    const funnel = metrics?.overview;
    const daily = metrics?.dailyStats ?? [];
    return (
      <div>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 28 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
            <h1 className="page-title">{t("overview.myPipeline", locale)}</h1>
            <span className="lead-count">{me?.repName} · {t("overview.personalView", locale)}</span>
          </div>
          <a href="/pipeline#mode=review" className="btn btn-primary" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {t("overview.openNextBatch", locale)}
          </a>
        </div>

        {/* Pipeline counters (from /api/metrics/me) */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 16 }}>
          {[
            { label: t("stat.assignedToMe", locale), value: m?.assigned ?? 0, color: "var(--text)" },
            { label: t("stat.readyToSend",  locale), value: m?.ready ?? 0,    color: "var(--blue)" },
            { label: t("stat.sent",         locale), value: m?.sent ?? 0,     color: "var(--green)" },
            { label: t("stat.wechatAdded",  locale), value: m?.wechat ?? 0,   color: "var(--green)" },
          ].map((c) => (
            <div key={c.label} className="stat-card">
              <div className="stat-label">{c.label}</div>
              <div className="stat-value" style={{ color: c.color }}>{c.value}</div>
            </div>
          ))}
        </div>

        {/* Funnel rates (from /api/metrics, scoped by server) */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 24 }}>
          <div className="stat-card">
            <div className="stat-label">{t("stat.deliveryRate", locale)}</div>
            <div className="stat-value" style={{ color: "var(--green)" }}>{funnel?.deliveryRate ?? "0"}%</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">{t("stat.clickRate", locale)}</div>
            <div className="stat-value" style={{ color: "var(--blue)" }}>{funnel?.clickRate ?? "0"}%</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">{t("stat.leadRateFull", locale)}</div>
            <div className="stat-value" style={{ color: "var(--green)" }}>{m?.leadRate ?? "0.0"}%</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">{t("stat.replies", locale)}</div>
            <div className="stat-value">{m?.replied ?? 0}</div>
          </div>
        </div>

        {/* Daily chart — same component admin sees, fed with this rep's
            dailyStats (server-scoped by rep sender_email). */}
        {daily.length > 0 && (
          <div className="section-card" style={{ marginBottom: 24 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
              <TrendingUp style={{ width: 16, height: 16, color: "var(--text-secondary)" }} />
              <h3 style={{ marginBottom: 0 }}>{t("overview.last30My", locale)}</h3>
            </div>
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={daily}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" />
                <XAxis
                  dataKey="date"
                  tickFormatter={(d) => new Date(d).toLocaleDateString("en", { month: "short", day: "numeric" })}
                  stroke="var(--text-tertiary)"
                  tick={{ fontSize: 11, fill: "var(--text-tertiary)" }}
                />
                <YAxis stroke="var(--text-tertiary)" tick={{ fontSize: 11, fill: "var(--text-tertiary)" }} />
                <Tooltip
                  contentStyle={CHART_TOOLTIP}
                  labelFormatter={(d) => new Date(d).toLocaleDateString("en", { month: "long", day: "numeric" })}
                />
                <Area type="monotone" dataKey="sent" stroke="#2563EB" fill="#2563EB" fillOpacity={0.12} />
                <Area type="monotone" dataKey="delivered" stroke="#16A34A" fill="#16A34A" fillOpacity={0.12} />
                <Area type="monotone" dataKey="clicked" stroke="#7C3AED" fill="#7C3AED" fillOpacity={0.12} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}

      </div>
    );
  }

  if (!metrics) {
    return (
      <div>
        <h1 className="page-title">{t("overview.title", locale)}</h1>
        <p style={{ color: "var(--text-secondary)", marginTop: 12 }}>{t("overview.failedMetrics", locale)}</p>
      </div>
    );
  }

  const o = metrics.overview;

  return (
    <div>
      {/* ── Page Header ── */}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
          <h1 className="page-title">{t("overview.title", locale)}</h1>
          <span className="lead-count">{t("overview.subtitle", locale)}</span>
        </div>
      </div>

      {/* ── Today prompt — what should you actually do on this page? ── */}
      {me && <TodayPrompt role={me.role} repId={me.repId} repName={me.repName} />}

      {/* ── Stat Cards ── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 16, marginBottom: 24 }}>
        {statCards.map((card) => {
          const value = card.key === "wechatTotal"
            ? (metrics.wechat?.total ?? 0)
            : o[card.key as keyof typeof o];
          return (
            <div key={card.key} className="stat-card">
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <card.icon style={{ width: 14, height: 14, color: card.color }} />
                <span className="stat-label" style={{ marginBottom: 0 }}>{card.label}</span>
              </div>
              <div className="stat-value">{String(value)}</div>
            </div>
          );
        })}
      </div>

      {/* ── Rates ── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 24 }}>
        {[
          { label: t("stat.deliveryRate", locale), value: o.deliveryRate, suffix: "%", color: "var(--green)" },
          { label: t("stat.clickRate",    locale), value: o.clickRate,    suffix: "%", color: "var(--blue)" },
          {
            label: t("stat.leadRate", locale),
            // Denominator is Resend-actual totalSent (live), NOT
            // pipeline_leads.sent (~30 rows). Using pipeline sent here
            // inflated the rate by ~30x because most historical sends
            // never transited pipeline_leads.
            value: o.totalSent > 0
              ? ((metrics.wechat?.total ?? 0) / o.totalSent * 100).toFixed(1)
              : "0.0",
            suffix: "%",
            color: "var(--green)",
          },
        ].map((rate) => (
          <div key={rate.label} className="stat-card">
            <div className="stat-label">{rate.label}</div>
            <div className="stat-value" style={{ color: rate.color }}>
              {rate.value}{rate.suffix}
            </div>
          </div>
        ))}
      </div>

      {/* ── Chart ── */}
      <div className="section-card" style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
          <TrendingUp style={{ width: 16, height: 16, color: "var(--text-secondary)" }} />
          <h3 style={{ marginBottom: 0 }}>{t("overview.last30", locale)}</h3>
        </div>
        <ResponsiveContainer width="100%" height={280}>
          <AreaChart data={metrics.dailyStats}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" />
            <XAxis
              dataKey="date"
              tickFormatter={(d) => new Date(d).toLocaleDateString("en", { month: "short", day: "numeric" })}
              stroke="var(--text-tertiary)"
              tick={{ fontSize: 11, fill: "var(--text-tertiary)" }}
            />
            <YAxis stroke="var(--text-tertiary)" tick={{ fontSize: 11, fill: "var(--text-tertiary)" }} />
            <Tooltip
              contentStyle={CHART_TOOLTIP}
              labelFormatter={(d) => new Date(d).toLocaleDateString("en", { month: "long", day: "numeric" })}
            />
            <Area type="monotone" dataKey="sent" stroke="#2563EB" fill="#2563EB" fillOpacity={0.12} />
            <Area type="monotone" dataKey="delivered" stroke="#16A34A" fill="#16A34A" fillOpacity={0.12} />
            <Area type="monotone" dataKey="clicked" stroke="#7C3AED" fill="#7C3AED" fillOpacity={0.12} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* ── Recent Events ── */}
      <div className="section-card" style={{ padding: 0 }}>
        <div style={{ padding: "20px 24px", borderBottom: "1px solid var(--border-light)" }}>
          <h3 style={{ marginBottom: 0 }}>{t("overview.recentActivity", locale)}</h3>
        </div>
        {metrics.recentEvents.length === 0 ? (
          <div className="empty-state" style={{ border: "none", padding: "48px 24px" }}>
            <div className="empty-icon">
              <Send style={{ width: 20, height: 20 }} />
            </div>
            <h3>{t("overview.noActivity", locale)}</h3>
            <p>{t("overview.noActivitySub", locale)}</p>
          </div>
        ) : (
          <div>
            {metrics.recentEvents.slice(0, 20).map((event, i, arr) => (
              <div
                key={event.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "14px 24px",
                  borderBottom: i === arr.length - 1 ? "none" : "1px solid var(--border-light)",
                  transition: "background 0.15s ease",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      borderRadius: 20,
                      background: "var(--bg)",
                      border: "1px solid var(--border-light)",
                      padding: "2px 10px",
                      fontSize: 11,
                      fontWeight: 600,
                      color: "var(--text-secondary)",
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                    }}
                  >
                    {event.type.replace("email.", "")}
                  </span>
                  <span
                    style={{
                      fontSize: 13,
                      color: "var(--text)",
                      maxWidth: 320,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {event.to || "—"}
                  </span>
                </div>
                <span style={{ fontSize: 12, color: "var(--text-tertiary)", fontVariantNumeric: "tabular-nums" }}>
                  {new Date(event.createdAt).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Today prompt — role-aware "what should you do here?" strip ────

interface AdminPrompt {
  role: "admin";
  stuck_count: number;
  watch_count: number;
  inbox_pending: number;
  congress_pending: number;
}
interface RepPrompt {
  role: "rep";
  rep_name: string;
  today_goal: string | null;
  missions_done: number;
  missions_total: number;
  ready_queue: number;
}

function TodayPrompt({ role, repId, repName }: { role: "admin" | "sales"; repId: number; repName: string }) {
  const [data, setData] = useState<AdminPrompt | RepPrompt | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        if (role === "admin") {
          // Pull team-overview + inbox counts in parallel
          const [overviewR, inboxR] = await Promise.all([
            fetch("/api/admin/team-overview", { credentials: "include", cache: "no-store" }).then((r) => r.ok ? r.json() : null),
            fetch("/api/admin/inbox?status=new", { credentials: "include", cache: "no-store" }).then((r) => r.ok ? r.json() : null),
          ]);
          const reps = overviewR?.reps ?? [];
          const inboxRows = inboxR?.rows ?? [];
          const congressPending = inboxRows.filter((r: { evidence?: { source?: string } }) =>
            r.evidence?.source === "congress",
          ).length;
          if (!cancelled) {
            setData({
              role: "admin",
              stuck_count: reps.filter((r: { health: string }) => r.health === "stuck").length,
              watch_count: reps.filter((r: { health: string }) => r.health === "watch").length,
              inbox_pending: inboxRows.length,
              congress_pending: congressPending,
            });
          }
        } else {
          // Rep view: today's brief + missions snapshot from /api/missions
          const r = await fetch("/api/missions", { credentials: "include", cache: "no-store" });
          if (!r.ok) return;
          const j = await r.json();
          const missions = (j.my_today ?? []) as Array<{ progress_count: number | null; target: number }>;
          const done = missions.filter((m) => (m.progress_count ?? 0) >= m.target).length;
          // Ready queue — count of leads assigned to me with status=ready.
          // /api/pipeline/ready-count returns { count } scoped by session.
          let ready = 0;
          try {
            const rr = await fetch("/api/pipeline/ready-count", { credentials: "include", cache: "no-store" });
            if (rr.ok) ready = (await rr.json())?.count ?? 0;
          } catch {/* best-effort */}
          if (!cancelled) {
            setData({
              role: "rep",
              rep_name: repName,
              today_goal: j.today_brief?.goal ?? null,
              missions_done: done,
              missions_total: missions.length,
              ready_queue: ready,
            });
          }
        }
      } catch {/* silent */}
    }
    void load();
  }, [role, repId, repName]);

  if (!data) return null;

  // Compose the prompt content
  if (data.role === "admin") {
    const hasAttention = data.stuck_count > 0 || data.watch_count > 0 || data.inbox_pending > 5;
    return (
      <div className="section-card" style={{
        padding: "14px 20px", marginBottom: 24,
        borderLeft: `3px solid ${hasAttention ? "var(--gold)" : "var(--green)"}`,
      }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap",
          fontSize: 13,
        }}>
          <span style={{
            fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)",
            textTransform: "uppercase", letterSpacing: "0.06em",
          }}>
            Today
          </span>
          {data.stuck_count > 0 && (
            <PromptStat label="stuck reps" value={data.stuck_count} color="var(--coral)" href="/missions" />
          )}
          {data.watch_count > 0 && (
            <PromptStat label="need a look" value={data.watch_count} color="var(--gold)" href="/missions" />
          )}
          {data.inbox_pending > 0 && (
            <PromptStat
              label="inbox pending"
              value={data.inbox_pending}
              color={data.inbox_pending > 10 ? "var(--gold)" : "var(--text-secondary)"}
              href="/admin/inbox"
            />
          )}
          {data.congress_pending > 0 && (
            <PromptStat label="congress proposals" value={data.congress_pending} color="var(--blue)" href="/admin/inbox" />
          )}
          {!hasAttention && (
            <span style={{ color: "var(--text-secondary)" }}>
              Team's healthy. Nothing pressing on your desk.
            </span>
          )}
        </div>
      </div>
    );
  }

  // Rep view
  return (
    <div className="section-card" style={{
      padding: "14px 20px", marginBottom: 24,
      borderLeft: `3px solid var(--blue)`,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)",
            textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4,
          }}>
            Today
          </div>
          {data.today_goal ? (
            <div style={{
              fontFamily: "var(--font-heading)", fontSize: 16,
              color: "var(--text)", lineHeight: 1.35, letterSpacing: "-0.01em",
            }}>
              {data.today_goal}
            </div>
          ) : (
            <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
              {data.rep_name}, 今天没特别的目标 — 按常规节奏跑就行.
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 16, fontSize: 13, alignItems: "center" }}>
          {data.missions_total > 0 && (
            <a href="/missions" style={{
              color: data.missions_done >= data.missions_total ? "var(--green)" : "var(--text-secondary)",
              fontVariantNumeric: "tabular-nums", textDecoration: "none",
            }}>
              <strong>{data.missions_done}/{data.missions_total}</strong>{" "}
              <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>missions</span>
            </a>
          )}
          {data.ready_queue > 0 && (
            <a href="/pipeline" style={{
              color: "var(--blue)", fontVariantNumeric: "tabular-nums", textDecoration: "none",
            }}>
              <strong>{data.ready_queue}</strong>{" "}
              <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>ready to send</span>
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function PromptStat({ label, value, color, href }: { label: string; value: number; color: string; href: string }) {
  return (
    <a href={href} style={{
      display: "inline-flex", alignItems: "baseline", gap: 4,
      color: color, textDecoration: "none",
    }}>
      <strong style={{ fontVariantNumeric: "tabular-nums" }}>{value}</strong>
      <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>{label}</span>
    </a>
  );
}
