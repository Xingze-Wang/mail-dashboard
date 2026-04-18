"use client";

import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import { Analytics, SourceRow } from "./types";

const CHART_TOOLTIP = {
  backgroundColor: "#FFFFFF",
  border: "1px solid rgba(0,0,0,0.08)",
  borderRadius: 8,
  fontSize: 12,
  color: "#1A1A1A",
  boxShadow: "0 4px 12px rgba(0,0,0,0.06)",
};

const REP_BAR_COLORS = [
  "#2563EB", // blue
  "#BE185D", // pink
  "#16A34A", // green
  "#B45309", // amber
  "#7C3AED", // purple
  "#0891B2", // cyan
];

function colorForRep(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return REP_BAR_COLORS[h % REP_BAR_COLORS.length];
}

function ChannelCard({ row }: { row: SourceRow }) {
  const empty = row.total === 0;
  const sentPct = row.total > 0 ? Math.round((row.sent / row.total) * 100) : 0;
  const repliedPct = row.sent > 0 ? Math.round((row.replied / row.sent) * 100) : 0;

  return (
    <div className="section-card" style={{ padding: 0 }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "20px 24px", borderBottom: "1px solid var(--border-light)",
      }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <h3 style={{ marginBottom: 0 }}>{row.source}</h3>
          {empty
            ? <span style={{ fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic" }}>No data yet</span>
            : <span style={{ fontSize: 13, color: "var(--text-tertiary)" }}>{row.total.toLocaleString()} leads</span>}
        </div>
        <span className="lead-count">{row.convRate}% → WeChat</span>
      </div>

      {empty ? (
        <div style={{ padding: "32px 24px", textAlign: "center", color: "var(--text-tertiary)", fontSize: 13 }}>
          Scraper for {row.source} hasn’t shipped data yet.
        </div>
      ) : (
        <div style={{ padding: "20px 24px" }}>
          {/* Metric grid */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 16, marginBottom: 20 }}>
            <Metric label="Strong"  value={row.strong.toLocaleString()} accent="var(--gold)" />
            <Metric label="Normal"  value={row.normal.toLocaleString()} />
            <Metric label="Sent"    value={row.sent.toLocaleString()}    sub={`${sentPct}% of total`} />
            <Metric label="Replied" value={row.replied.toLocaleString()} sub={`${repliedPct}% of sent`} />
            <Metric label="WeChat"  value={row.wechat.toLocaleString()}  accent="var(--green)" />
            <Metric label="Conv."   value={`${row.convRate}%`}           accent="var(--green)" />
          </div>

          {/* Sales allocation */}
          <div style={{ marginTop: 8 }}>
            <div style={{
              fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)",
              textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8,
            }}>
              Assigned Sales ({row.reps.length})
            </div>
            <RepBar reps={row.reps} total={row.total} />
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 10 }}>
              {row.reps.map((r) => {
                const pct = row.total > 0 ? Math.round((r.count / row.total) * 100) : 0;
                const color = r.repId === null ? "var(--text-tertiary)" : colorForRep(r.repName);
                return (
                  <div key={r.repName} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 4, background: color }} />
                    <span style={{ color: "var(--text)", fontWeight: 500 }}>{r.repName}</span>
                    <span style={{ color: "var(--text-tertiary)" }}>{r.count} ({pct}%)</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, sub, accent }: {
  label: string; value: string; sub?: string; accent?: string;
}) {
  return (
    <div>
      <div style={{
        fontSize: 11, fontWeight: 500, color: "var(--text-tertiary)",
        textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4,
      }}>
        {label}
      </div>
      <div style={{
        fontFamily: "var(--font-heading)", fontSize: 22, fontWeight: 600,
        color: accent ?? "var(--text)", letterSpacing: "-0.01em",
      }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function RepBar({ reps, total }: { reps: SourceRow["reps"]; total: number }) {
  if (total === 0) return null;
  return (
    <div style={{
      display: "flex", height: 8, width: "100%",
      borderRadius: 4, overflow: "hidden",
      border: "1px solid var(--border-light)",
    }}>
      {reps.map((r) => {
        const pct = (r.count / total) * 100;
        const color = r.repId === null ? "var(--text-tertiary)" : colorForRep(r.repName);
        return (
          <div
            key={r.repName}
            title={`${r.repName}: ${r.count} (${pct.toFixed(1)}%)`}
            style={{ width: `${pct}%`, background: color }}
          />
        );
      })}
    </div>
  );
}

export function ChannelsTab({ analytics }: { analytics: Analytics }) {
  const { channels } = analytics;
  const strongPct = channels.totalLeads > 0
    ? ((channels.strongLeads / channels.totalLeads) * 100).toFixed(1)
    : "0";

  const stats = [
    { label: "Total Leads",   value: channels.totalLeads.toLocaleString(),       sub: `+${channels.leadsThisWeek} this week`, neutral: false },
    { label: "Strong Leads",  value: channels.strongLeads.toLocaleString(),      sub: `${strongPct}% of total`,               neutral: true  },
    { label: "Avg h-index",   value: String(channels.avgHIndex),                 sub: undefined,                              neutral: true  },
    { label: "Send → WeChat", value: `${channels.conversionRate}%`,              sub: undefined,                              neutral: true  },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {/* Top KPIs */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
        {stats.map((c) => (
          <div key={c.label} className="stat-card">
            <div className="stat-label">{c.label}</div>
            <div className="stat-value">{c.value}</div>
            {c.sub && <div className={`stat-sub${c.neutral ? " neutral" : ""}`}>{c.sub}</div>}
          </div>
        ))}
      </div>

      {/* Daily discovery chart */}
      <div className="section-card">
        <h3>Leads Discovered (Last 30 Days)</h3>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={channels.daily}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.05)" />
            <XAxis dataKey="date" tickFormatter={(d: string) => d.slice(5)} stroke="var(--text-tertiary)" tick={{ fontSize: 11 }} />
            <YAxis stroke="var(--text-tertiary)" tick={{ fontSize: 11 }} />
            <Tooltip contentStyle={CHART_TOOLTIP} />
            <Bar dataKey="normal" stackId="a" fill="#93C5FD" />
            <Bar dataKey="strong" stackId="a" fill="#B45309" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Per-channel cards */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ fontFamily: "var(--font-heading)", fontSize: 18, fontWeight: 600, letterSpacing: "-0.01em" }}>
          Channels
        </div>
        {channels.sources.map((row) => <ChannelCard key={row.source} row={row} />)}
      </div>

      {/* h-index distribution */}
      <div className="section-card">
        <h3>h-index Distribution</h3>
        <ResponsiveContainer width="100%" height={160}>
          <BarChart data={channels.hIndexDist}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.05)" />
            <XAxis dataKey="min" stroke="var(--text-tertiary)" tick={{ fontSize: 10 }} />
            <YAxis stroke="var(--text-tertiary)" tick={{ fontSize: 10 }} />
            <Tooltip contentStyle={CHART_TOOLTIP} />
            <Bar dataKey="count" fill="#93C5FD" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export default ChannelsTab;
