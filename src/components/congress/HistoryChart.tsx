import type { WeeklyMetric, DecisionMarker, DecisionStatus } from "@/lib/congress/types";

const PLOT = { left: 40, right: 660, top: 20, bottom: 220, yMin: 0, yMax: 6, weekMin: 1, weekMax: 18 };

const xFor = (week: number) => {
  const span = PLOT.right - PLOT.left;
  const range = PLOT.weekMax - PLOT.weekMin;
  return PLOT.left + ((week - PLOT.weekMin) / Math.max(1, range)) * span;
};
const yFor = (rate: number) => {
  const span = PLOT.bottom - PLOT.top;
  const range = PLOT.yMax - PLOT.yMin;
  return PLOT.bottom - ((rate - PLOT.yMin) / range) * span;
};

const DOT_FILL: Record<DecisionStatus, string> = {
  approved: "fill-emerald-600 dark:fill-emerald-400",
  rejected: "fill-zinc-400 dark:fill-zinc-500",
  measuring: "fill-sky-600 dark:fill-sky-400",
  reverted: "fill-red-600 dark:fill-red-400",
  pending: "fill-amber-600 dark:fill-amber-400",
  deferred: "fill-violet-600 dark:fill-violet-400",
};

export function HistoryChart({ metrics, markers }: { metrics: WeeklyMetric[]; markers: DecisionMarker[] }) {
  const polylinePoints = metrics.map((m) => `${xFor(m.week)},${yFor(m.conversion_rate)}`).join(" ");
  const yTicks = [0, 2, 4, 6];
  const xTicks = metrics.length >= 5 ? [metrics[0].week, metrics[Math.floor(metrics.length / 4)].week, metrics[Math.floor(metrics.length / 2)].week, metrics[Math.floor(3 * metrics.length / 4)].week, metrics[metrics.length - 1].week] : metrics.map((m) => m.week);
  const rateByWeek = new Map(metrics.map((m) => [m.week, m.conversion_rate]));

  return (
    <svg viewBox="0 0 680 260" className="block w-full">
      <line x1={PLOT.left} y1={yFor(0)} x2={PLOT.right} y2={yFor(0)} strokeWidth={0.5} className="stroke-zinc-300 dark:stroke-zinc-600" />
      {yTicks.slice(1).map((tick) => (
        <line key={`grid-${tick}`} x1={PLOT.left} y1={yFor(tick)} x2={PLOT.right} y2={yFor(tick)} strokeWidth={0.5} strokeDasharray="2 3" className="stroke-zinc-200 dark:stroke-zinc-700" />
      ))}
      {yTicks.map((tick) => (
        <text key={`y-${tick}`} x={PLOT.left - 5} y={yFor(tick) + 3} textAnchor="end" fontSize={11} className="fill-zinc-500 dark:fill-zinc-400">
          {tick}%
        </text>
      ))}
      {xTicks.map((week) => (
        <text key={`x-${week}`} x={xFor(week)} y={240} textAnchor="middle" fontSize={11} className="fill-zinc-500 dark:fill-zinc-400">
          W{week}
        </text>
      ))}
      <polyline points={polylinePoints} fill="none" strokeWidth={1.5} strokeLinejoin="round" className="stroke-sky-600 dark:stroke-sky-400" />
      {markers.map((m) => {
        const rate = rateByWeek.get(m.week);
        if (rate == null) return null;
        return (
          <circle key={m.proposal_id} cx={xFor(m.week)} cy={yFor(rate)} r={6} strokeWidth={2} className={`${DOT_FILL[m.status] ?? DOT_FILL.pending} stroke-white dark:stroke-zinc-950`}>
            <title>{`W${m.week} · ${m.title}${m.outcome ? ` · ${m.outcome}` : ""}`}</title>
          </circle>
        );
      })}
    </svg>
  );
}
