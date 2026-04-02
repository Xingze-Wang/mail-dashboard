"use client";

import { useEffect, useState } from "react";
import {
  Send,
  CheckCircle2,
  Eye,
  MousePointerClick,
  AlertTriangle,
  Inbox,
  TrendingUp,
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
    totalOpened: number;
    totalClicked: number;
    totalBounced: number;
    totalComplained: number;
    totalInbound: number;
    last7DaysSent: number;
    deliveryRate: string;
    openRate: string;
    clickRate: string;
    bounceRate: string;
  };
  dailyStats: { date: string; sent: number; delivered: number; opened: number; bounced: number }[];
  recentEvents: { id: string; type: string; createdAt: string; to?: string; subject?: string }[];
}

const statCards = [
  { key: "totalSent", label: "Sent", icon: Send, color: "text-blue-400" },
  { key: "totalDelivered", label: "Delivered", icon: CheckCircle2, color: "text-green-400" },
  { key: "totalOpened", label: "Opened", icon: Eye, color: "text-purple-400" },
  { key: "totalClicked", label: "Clicked", icon: MousePointerClick, color: "text-indigo-400" },
  { key: "totalBounced", label: "Bounced", icon: AlertTriangle, color: "text-red-400" },
  { key: "totalInbound", label: "Received", icon: Inbox, color: "text-cyan-400" },
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
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="animate-pulse text-neutral-500 text-sm">Loading...</div>
      </div>
    );
  }

  if (!metrics) {
    return (
      <div className="p-8">
        <p className="text-neutral-400">Failed to load metrics</p>
      </div>
    );
  }

  const o = metrics.overview;

  return (
    <div className="p-8 max-w-[1200px]">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-white tracking-tight">Overview</h1>
        <p className="text-sm text-neutral-400 mt-1">Email delivery metrics and activity</p>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
        {statCards.map((card) => {
          const value = o[card.key as keyof typeof o];
          return (
            <div key={card.key} className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-4">
              <div className="flex items-center gap-2 mb-2">
                <card.icon className={`h-4 w-4 ${card.color}`} />
                <span className="text-[12px] font-medium text-neutral-400">{card.label}</span>
              </div>
              <p className="text-2xl font-semibold text-white tabular-nums">{String(value)}</p>
            </div>
          );
        })}
      </div>

      {/* Rates */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        {[
          { label: "Delivery Rate", value: o.deliveryRate, suffix: "%" },
          { label: "Open Rate", value: o.openRate, suffix: "%" },
          { label: "Click Rate", value: o.clickRate, suffix: "%" },
          { label: "Bounce Rate", value: o.bounceRate, suffix: "%", negative: true },
        ].map((rate) => (
          <div key={rate.label} className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-4">
            <p className="text-[12px] font-medium text-neutral-400 mb-1">{rate.label}</p>
            <p className={`text-xl font-semibold ${rate.negative ? "text-red-400" : "text-white"}`}>
              {rate.value}{rate.suffix}
            </p>
          </div>
        ))}
      </div>

      {/* Chart */}
      <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-6 mb-8">
        <div className="flex items-center gap-2 mb-4">
          <TrendingUp className="h-4 w-4 text-neutral-400" />
          <h2 className="text-[14px] font-semibold text-white">Last 30 Days</h2>
        </div>
        <ResponsiveContainer width="100%" height={280}>
          <AreaChart data={metrics.dailyStats}>
            <CartesianGrid strokeDasharray="3 3" stroke="#262626" />
            <XAxis
              dataKey="date"
              tickFormatter={(d) => new Date(d).toLocaleDateString("en", { month: "short", day: "numeric" })}
              stroke="#525252"
              tick={{ fontSize: 11 }}
            />
            <YAxis stroke="#525252" tick={{ fontSize: 11 }} />
            <Tooltip
              contentStyle={{
                backgroundColor: "#171717",
                border: "1px solid #333",
                borderRadius: "8px",
                fontSize: "12px",
              }}
              labelFormatter={(d) => new Date(d).toLocaleDateString("en", { month: "long", day: "numeric" })}
            />
            <Area type="monotone" dataKey="sent" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.1} />
            <Area type="monotone" dataKey="delivered" stroke="#22c55e" fill="#22c55e" fillOpacity={0.1} />
            <Area type="monotone" dataKey="opened" stroke="#a855f7" fill="#a855f7" fillOpacity={0.1} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Recent Events */}
      <div className="rounded-xl border border-neutral-800 bg-neutral-900/50">
        <div className="px-5 py-4 border-b border-neutral-800">
          <h2 className="text-[14px] font-semibold text-white">Recent Activity</h2>
        </div>
        <div className="divide-y divide-neutral-800/50">
          {metrics.recentEvents.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-neutral-500">
              No events yet. Send your first email to see activity here.
            </div>
          ) : (
            metrics.recentEvents.slice(0, 20).map((event) => (
              <div key={event.id} className="flex items-center justify-between px-5 py-3">
                <div className="flex items-center gap-3">
                  <span className="inline-flex items-center rounded-full bg-neutral-800 px-2.5 py-0.5 text-[11px] font-medium text-neutral-300">
                    {event.type.replace("email.", "")}
                  </span>
                  <span className="text-[13px] text-neutral-300 truncate max-w-[300px]">
                    {event.to || "—"}
                  </span>
                </div>
                <span className="text-[12px] text-neutral-500">
                  {new Date(event.createdAt).toLocaleString()}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
