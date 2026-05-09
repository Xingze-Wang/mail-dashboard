// /congress/history — weekly WeChat conversion rate with decision markers.

import Link from "next/link";
import { headers, cookies } from "next/headers";
import type { WeeklyMetric, DecisionMarker } from "@/lib/congress/types";
import { HistoryChart } from "@/components/congress/HistoryChart";
import { StatusPill, STATUS_DOT_BG } from "@/components/congress/StatusPill";

export const dynamic = "force-dynamic";

interface HistoryData { metrics: WeeklyMetric[]; markers: DecisionMarker[] }

async function getHistory(): Promise<HistoryData | null> {
  const h = await headers();
  const c = await cookies();
  const host = h.get("host") ?? "calistamind.com";
  const proto = host.startsWith("localhost") ? "http" : "https";
  const cookieStr = c.getAll().map((x) => `${x.name}=${x.value}`).join("; ");
  const res = await fetch(`${proto}://${host}/api/congress/history`, {
    headers: { cookie: cookieStr },
    cache: "no-store",
  });
  if (!res.ok) return null;
  return res.json();
}

export default async function CongressHistoryPage() {
  const data = await getHistory();
  if (!data || data.metrics.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-6 text-[13px] text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
        No history data yet. Run a few cron cycles + ship a decision before this view becomes useful.
      </div>
    );
  }

  const first = data.metrics[0]?.conversion_rate ?? 0;
  const last = data.metrics[data.metrics.length - 1]?.conversion_rate ?? 0;
  const delta = (last - first).toFixed(1);
  const shipped = data.markers.filter((d) => d.status === "approved" || d.status === "measuring").length;
  const reverted = data.markers.filter((d) => d.status === "reverted").length;

  return (
    <div style={{ maxWidth: 880, margin: "0 auto" }}>
      <header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>
            Congress · History
          </div>
          <h1 className="page-title">Organizational history</h1>
          <p style={{ fontSize: 13, color: "var(--text-tertiary)", marginTop: 4 }}>
            WeChat conversion rate by week, with congress decisions annotated. Last 18 weeks.
          </p>
        </div>
      </header>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric label="Current rate" value={`${last.toFixed(1)}%`} />
        <Metric
          label={`Vs week ${data.metrics[0]?.week ?? 1}`}
          value={`${last >= first ? "+" : ""}${delta} pp`}
          tone={last >= first ? "positive" : "negative"}
        />
        <Metric label="Decisions shipped" value={String(shipped)} />
        <Metric label="Reverted" value={String(reverted)} tone={reverted > 0 ? "negative" : undefined} />
      </div>

      <div className="mb-6">
        <HistoryChart metrics={data.metrics} markers={data.markers} />
      </div>

      <section>
        <h2 className="mb-2 text-sm font-medium">Decisions in this window</h2>
        {data.markers.length === 0 ? (
          <div className="py-6 text-center text-[13px] text-zinc-500 dark:text-zinc-400">
            No decisions yet — run the weekly congress + approve a proposal to populate this list.
          </div>
        ) : (
          <div className="text-[13px]">
            {data.markers.map((d, i) => (
              <Link
                key={d.proposal_id}
                href={`/congress/proposals/${d.proposal_id}`}
                className={`flex items-center gap-3 py-2.5 hover:bg-zinc-50 dark:hover:bg-zinc-900 ${
                  i < data.markers.length - 1 ? "border-b border-zinc-200 dark:border-zinc-800" : ""
                }`}
              >
                <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${STATUS_DOT_BG[d.status]}`} />
                <span className="min-w-[36px] text-xs text-zinc-500 dark:text-zinc-500">W{d.week}</span>
                <StatusPill status={d.status} />
                <span className="flex-1 truncate">{d.title}</span>
                <span
                  className={
                    d.outcome?.startsWith("+")
                      ? "font-medium text-emerald-700 dark:text-emerald-400"
                      : d.outcome?.startsWith("−") || d.outcome?.startsWith("-")
                        ? "font-medium text-red-700 dark:text-red-400"
                        : "text-zinc-500 dark:text-zinc-400"
                  }
                >
                  {d.outcome ?? "—"}
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="mt-6 text-[12px] text-zinc-500 dark:text-zinc-500">
        Showing {data.metrics.length} weeks. Filter by metric / slice (rep / category / tier) coming once we have ≥3 shipped decisions.
      </section>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "positive" | "negative" }) {
  const toneClass =
    tone === "positive" ? "text-emerald-700 dark:text-emerald-400"
    : tone === "negative" ? "text-red-700 dark:text-red-400"
    : "";
  return (
    <div className="rounded-md bg-zinc-50 p-3.5 dark:bg-zinc-900">
      <div className="mb-1 text-xs text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className={`text-[22px] font-medium ${toneClass}`}>{value}</div>
    </div>
  );
}
