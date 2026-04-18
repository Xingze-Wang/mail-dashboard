"use client";

import { useEffect, useState } from "react";
import {
  Send,
  CheckCircle2,
  MousePointerClick,
  AlertTriangle,
  Inbox,
  Zap,
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
];

export default function OverviewPage() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/metrics")
      .then((res) => res.json())
      .then(setMetrics)
      .catch(console.error)
      .finally(() => setLoading(false));

    // Sync from Resend in background — keep re-calling until all pages are imported
    const runSync = async () => {
      try {
        let complete = false;
        while (!complete) {
          const res = await fetch("/api/sync");
          const data = await res.json();
          complete = data.complete !== false;
          const metricsRes = await fetch("/api/metrics");
          const metricsData = await metricsRes.json();
          if (metricsData) setMetrics(metricsData);
          if (!complete) {
            await new Promise((r) => setTimeout(r, 500));
          }
        }
      } catch {
        // Sync failed, metrics already loaded from initial fetch
      }
    };
    runSync();
  }, []);

  if (loading) {
    return (
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28 }}>
          <h1 className="page-title">Overview</h1>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 16, marginBottom: 24 }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="skeleton" style={{ height: 92 }} />
          ))}
        </div>
        <div className="skeleton" style={{ height: 320 }} />
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
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 16, marginBottom: 24 }}>
        {statCards.map((card) => {
          const value = o[card.key as keyof typeof o];
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
          { label: "Bounce Rate", value: o.bounceRate, suffix: "%", color: "var(--coral)" },
        ].map((rate) => (
          <div key={rate.label} className="stat-card">
            <div className="stat-label">{rate.label}</div>
            <div className="stat-value" style={{ color: rate.color }}>
              {rate.value}{rate.suffix}
            </div>
          </div>
        ))}
      </div>

      {/* ── Pipeline Stats ── */}
      {metrics.pipeline && metrics.pipeline.total > 0 && (
        <div className="section-card" style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
            <Zap style={{ width: 16, height: 16, color: "var(--gold)" }} />
            <h3 style={{ marginBottom: 0 }}>Pipeline</h3>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 24 }}>
            <div>
              <div className="stat-label" style={{ marginBottom: 6 }}>Ready to Send</div>
              <div style={{ fontFamily: "var(--font-heading)", fontSize: 22, fontWeight: 600, color: "var(--blue)", letterSpacing: "-0.01em" }}>
                {metrics.pipeline.ready}
              </div>
            </div>
            <div>
              <div className="stat-label" style={{ marginBottom: 6 }}>Sent</div>
              <div style={{ fontFamily: "var(--font-heading)", fontSize: 22, fontWeight: 600, color: "var(--green)", letterSpacing: "-0.01em" }}>
                {metrics.pipeline.sent}
              </div>
            </div>
            <div>
              <div className="stat-label" style={{ marginBottom: 6 }}>Total Leads</div>
              <div style={{ fontFamily: "var(--font-heading)", fontSize: 22, fontWeight: 600, color: "var(--text)", letterSpacing: "-0.01em" }}>
                {metrics.pipeline.total}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── WeChat Conversions ── */}
      {metrics.wechat && metrics.wechat.total > 0 && (
        <div
          className="section-card"
          style={{
            marginBottom: 24,
            background: "var(--green-bg)",
            borderColor: "#BBF7D0",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <MessageCircle style={{ width: 16, height: 16, color: "var(--green)" }} />
              <h3 style={{ marginBottom: 0 }}>WeChat Conversions</h3>
            </div>
            <span style={{ fontFamily: "var(--font-heading)", fontSize: 26, fontWeight: 600, color: "var(--green)", letterSpacing: "-0.01em" }}>
              {metrics.wechat.total}
            </span>
          </div>
          {metrics.wechat.recent.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {metrics.wechat.recent.slice(0, 5).map((r, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    fontSize: 12.5,
                  }}
                >
                  <span style={{ color: "var(--text)" }}>{r.query}</span>
                  <span style={{ color: "var(--text-tertiary)" }}>
                    {new Date(r.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </span>
                </div>
              ))}
            </div>
          )}
          {metrics.pipeline && metrics.pipeline.sent > 0 && (
            <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid #BBF7D0" }}>
              <p style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                Conversion rate:{" "}
                <span style={{ color: "var(--green)", fontWeight: 600 }}>
                  {((metrics.wechat.total / metrics.pipeline.sent) * 100).toFixed(1)}%
                </span>
                <span style={{ color: "var(--text-tertiary)" }}>
                  {" "}({metrics.wechat.total} / {metrics.pipeline.sent} sent)
                </span>
              </p>
            </div>
          )}
        </div>
      )}

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
