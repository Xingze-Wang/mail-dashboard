"use client";

import { useEffect, useState } from "react";
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

const statCards = [
  { key: "totalSent", label: "Sent", icon: Send, color: "var(--blue)" },
  { key: "totalDelivered", label: "Delivered", icon: CheckCircle2, color: "var(--green)" },
  { key: "totalClicked", label: "Clicked", icon: MousePointerClick, color: "var(--purple)" },
  { key: "totalBounced", label: "Bounced", icon: AlertTriangle, color: "var(--coral)" },
  { key: "totalInbound", label: "Received", icon: Inbox, color: "var(--blue)" },
  { key: "wechatTotal", label: "WeChat", icon: MessageCircle, color: "var(--green)" },
];

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
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [me, setMe] = useState<{ repId: number; repName: string; role: "admin" | "sales" } | null>(null);
  const [myMetrics, setMyMetrics] = useState<MyMetrics | null>(null);
  const [loading, setLoading] = useState(true);

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

    // Bounded /api/sync loop — max 10 iterations = 5s. Previously
    // unbounded while(!complete), could churn forever on a stuck sync.
    let cancelled = false;
    const runSync = async () => {
      try {
        let complete = false;
        let iter = 0;
        while (!complete && !cancelled && iter < 10) {
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
          <h1 className="page-title">Overview</h1>
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
            <h1 className="page-title">My Pipeline</h1>
            <span className="lead-count">{me?.repName} · personal view</span>
          </div>
          <a
            href="/pipeline#mode=review"
            className="btn btn-primary"
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            Open next batch →
          </a>
        </div>

        {/* Pipeline counters (from /api/metrics/me) */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 16 }}>
          {[
            { label: "Assigned to me",  value: m?.assigned ?? 0, color: "var(--text)" },
            { label: "Ready to send",   value: m?.ready ?? 0,    color: "var(--blue)" },
            { label: "Sent",            value: m?.sent ?? 0,     color: "var(--green)" },
            { label: "WeChat added",    value: m?.wechat ?? 0,   color: "var(--green)" },
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
            <div className="stat-label">Delivery rate</div>
            <div className="stat-value" style={{ color: "var(--green)" }}>{funnel?.deliveryRate ?? "0"}%</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Click rate</div>
            <div className="stat-value" style={{ color: "var(--blue)" }}>{funnel?.clickRate ?? "0"}%</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Lead rate (WeChat / Sent)</div>
            <div className="stat-value" style={{ color: "var(--green)" }}>{m?.leadRate ?? "0.0"}%</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Replies</div>
            <div className="stat-value">{m?.replied ?? 0}</div>
          </div>
        </div>

        {/* Daily chart — same component admin sees, fed with this rep's
            dailyStats (server-scoped by rep sender_email). */}
        {daily.length > 0 && (
          <div className="section-card" style={{ marginBottom: 24 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
              <TrendingUp style={{ width: 16, height: 16, color: "var(--text-secondary)" }} />
              <h3 style={{ marginBottom: 0 }}>Last 30 Days — My sends</h3>
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
        <h1 className="page-title">Overview</h1>
        <p style={{ color: "var(--text-secondary)", marginTop: 12 }}>Failed to load metrics</p>
      </div>
    );
  }

  const o = metrics.overview;

  return (
    <div>
      {/* ── Page Header ── */}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 28 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
          <h1 className="page-title">Overview</h1>
          <span className="lead-count">Email delivery & activity</span>
        </div>
      </div>

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
          { label: "Delivery Rate", value: o.deliveryRate, suffix: "%", color: "var(--green)" },
          { label: "Click Rate", value: o.clickRate, suffix: "%", color: "var(--blue)" },
          {
            label: "Lead Rate (WeChat)",
            value: metrics.pipeline && metrics.pipeline.sent > 0
              ? ((metrics.wechat?.total ?? 0) / metrics.pipeline.sent * 100).toFixed(1)
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
          <h3 style={{ marginBottom: 0 }}>Last 30 Days</h3>
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
          <h3 style={{ marginBottom: 0 }}>Recent Activity</h3>
        </div>
        {metrics.recentEvents.length === 0 ? (
          <div className="empty-state" style={{ border: "none", padding: "48px 24px" }}>
            <div className="empty-icon">
              <Send style={{ width: 20, height: 20 }} />
            </div>
            <h3>No activity yet</h3>
            <p>Send your first email to see delivery events here.</p>
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
