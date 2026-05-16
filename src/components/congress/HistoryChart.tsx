import type { WeeklyMetric, DecisionMarker, DecisionStatus } from "@/lib/congress/types";

// 3 MP-conversion lines on one chart, sharing the same emails denominator:
//   registered_rate — MP marks them past the front door (blue)
//   submitted_rate  — submitted an application (emerald, the conversion)
//   wechat_rate     — added on WeChat (rose, warm-touch)
// Colors here MUST match src/components/MpSignalPills.tsx COLORS so the
// chart + the inline pills tell the same visual story.
const LINE_COLORS = {
  registered: "#3b82f6",
  submitted: "#10b981",
  wechat: "#ec4899",
} as const;

const xFor = (week: number, weekMin: number, weekMax: number) => {
  const left = 40;
  const right = 660;
  const span = right - left;
  const range = Math.max(1, weekMax - weekMin);
  return left + ((week - weekMin) / range) * span;
};
const yFor = (rate: number, yMax: number) => {
  const top = 20;
  const bottom = 220;
  const span = bottom - top;
  return bottom - ((rate - 0) / yMax) * span;
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
  if (metrics.length === 0) return null;
  const weekMin = metrics[0].week;
  const weekMax = metrics[metrics.length - 1].week;

  // Dynamic y-max so a spike in registered_rate doesn't get clipped.
  // Floor at 6 to keep the original visual spacing when numbers are tiny.
  const maxObserved = Math.max(
    6,
    ...metrics.map((m) =>
      Math.max(m.conversion_rate, m.registered_rate, m.submitted_rate, m.wechat_rate),
    ),
  );
  // Round up to a nice tick.
  const yMax = Math.ceil(maxObserved / 2) * 2;

  const pointsFor = (selector: (m: WeeklyMetric) => number) =>
    metrics.map((m) => `${xFor(m.week, weekMin, weekMax)},${yFor(selector(m), yMax)}`).join(" ");

  const linePoints = {
    registered: pointsFor((m) => m.registered_rate),
    submitted: pointsFor((m) => m.submitted_rate),
    wechat: pointsFor((m) => m.wechat_rate),
  };

  // Decision dots sit on the WeChat line (matches the legacy conversion_rate).
  const wechatByWeek = new Map(metrics.map((m) => [m.week, m.wechat_rate]));

  const yTicks: number[] = [];
  const step = yMax / 3;
  for (let i = 0; i <= 3; i++) yTicks.push(Math.round(i * step * 10) / 10);

  const xTicks = metrics.length >= 5
    ? [metrics[0].week, metrics[Math.floor(metrics.length / 4)].week, metrics[Math.floor(metrics.length / 2)].week, metrics[Math.floor(3 * metrics.length / 4)].week, metrics[metrics.length - 1].week]
    : metrics.map((m) => m.week);

  return (
    <div>
      <svg viewBox="0 0 680 260" className="block w-full">
        <line x1={40} y1={yFor(0, yMax)} x2={660} y2={yFor(0, yMax)} strokeWidth={0.5} className="stroke-zinc-300 dark:stroke-zinc-600" />
        {yTicks.slice(1).map((tick) => (
          <line key={`grid-${tick}`} x1={40} y1={yFor(tick, yMax)} x2={660} y2={yFor(tick, yMax)} strokeWidth={0.5} strokeDasharray="2 3" className="stroke-zinc-200 dark:stroke-zinc-700" />
        ))}
        {yTicks.map((tick) => (
          <text key={`y-${tick}`} x={35} y={yFor(tick, yMax) + 3} textAnchor="end" fontSize={11} className="fill-zinc-500 dark:fill-zinc-400">
            {tick}%
          </text>
        ))}
        {xTicks.map((week) => (
          <text key={`x-${week}`} x={xFor(week, weekMin, weekMax)} y={240} textAnchor="middle" fontSize={11} className="fill-zinc-500 dark:fill-zinc-400">
            W{week}
          </text>
        ))}
        <polyline points={linePoints.registered} fill="none" strokeWidth={1.5} strokeLinejoin="round" stroke={LINE_COLORS.registered} />
        <polyline points={linePoints.submitted} fill="none" strokeWidth={1.5} strokeLinejoin="round" stroke={LINE_COLORS.submitted} />
        <polyline points={linePoints.wechat} fill="none" strokeWidth={1.5} strokeLinejoin="round" stroke={LINE_COLORS.wechat} />
        {markers.map((m) => {
          const rate = wechatByWeek.get(m.week);
          if (rate == null) return null;
          return (
            <circle key={m.proposal_id} cx={xFor(m.week, weekMin, weekMax)} cy={yFor(rate, yMax)} r={6} strokeWidth={2} className={`${DOT_FILL[m.status] ?? DOT_FILL.pending} stroke-white dark:stroke-zinc-950`}>
              <title>{`W${m.week} · ${m.title}${m.outcome ? ` · ${m.outcome}` : ""}`}</title>
            </circle>
          );
        })}
      </svg>
      <div style={{ display: "flex", gap: 16, fontSize: 11, color: "var(--text-tertiary)", marginTop: 6, flexWrap: "wrap" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <span style={{ width: 10, height: 2, background: LINE_COLORS.registered, display: "inline-block" }} />
          注册 rate
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <span style={{ width: 10, height: 2, background: LINE_COLORS.submitted, display: "inline-block" }} />
          开表 rate
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <span style={{ width: 10, height: 2, background: LINE_COLORS.wechat, display: "inline-block" }} />
          微信 rate
        </span>
      </div>
    </div>
  );
}
