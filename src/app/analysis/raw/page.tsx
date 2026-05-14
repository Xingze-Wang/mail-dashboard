"use client";

import { useEffect, useMemo, useState } from "react";
import { TrendingUp, Loader2, Filter, Info, Zap, AlertCircle, GitCompare } from "lucide-react";
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  ZAxis,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
} from "recharts";

interface BucketStats {
  bucket: string;
  population: number;
  sent: number;
  replied: number;
  wechat: number;
  replyRate: number;
  wechatRate: number;
  lowN: boolean;
}
interface DimensionBreakdown {
  dimension: string;
  label: string;
  coverage: number;
  population: number;
  totalSent: number;
  buckets: BucketStats[];
  maxWechatLift: number | null;
  maxReplyLift: number | null;
  hasSignal: boolean;
}
interface AnalysisResult {
  scope: { repId?: number | null; lookbackDays?: number | null };
  population: number;
  totalSent: number;
  totalReplied: number;
  totalWechat: number;
  baselineReplyRate: number;
  baselineWechatRate: number;
  dimensions: DimensionBreakdown[];
  scopeMeta: { isAdmin: boolean; effectiveRepId: number | null; lookbackDays: number | null };
}

interface Rep { id: number; name: string }

interface MetricsOverview {
  totalSent: number;
  totalDelivered: number;
  totalClicked: number;
  totalBounced: number;
}
interface MetricsResp {
  overview: MetricsOverview;
  wechat: { total: number };
}

interface SegmentStats {
  segment: string;
  delivered: number;
  clicked: number;
  wechat: number;
  ctr: number;
  postClickConv: number;
  endToEnd: number;
  lowN: boolean;
}
interface SegmentDim {
  dimension: string;
  label: string;
  segments: SegmentStats[];
}
interface SegmentFunnels {
  totals: { delivered: number; clicked: number; wechat: number; overallCtr: number; overallPostClick: number };
  dimensions: SegmentDim[];
}

interface InsightSegment {
  segment: string;
  dimension: string;
  ctr: number;
  postClickConv: number;
  delivered: number;
}
interface DiagnoseCard {
  covariate: string;
  prevDistribution: Record<string, number>;
  curDistribution: Record<string, number>;
  biggestShift: { bucket: string; from: number; to: number; deltaPct: number };
  hypothesis: string;
}
interface DiagnoseResult {
  metric: "click_rate" | "wechat_rate";
  windowDays: number;
  prevRate: number;
  curRate: number;
  ratioChange: number;
  noise: boolean;
  cards: DiagnoseCard[];
}
interface InsightsResp {
  scope: { repId: number | null; lookbackDays: number; isAdmin: boolean };
  totals: SegmentFunnels["totals"];
  winning: InsightSegment | null;
  losing: InsightSegment | null;
  headlineDrop: DiagnoseResult | { error: string };
}

interface LRModel {
  featureNames: string[];
  weights: number[];
  intercept: number;
  nSamples: number;
  nPositive: number;
  auc: number;
  logLoss: number;
  trainLogLoss: number;
  trained_at?: string;
  label_stats?: { recipients: number; clicked: number; wechat: number; either: number };
  label_weights?: { wechat: number; click: number };
}

const fmtPct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "—");
const fmtNum = (n: number) => n.toLocaleString();

export default function AnalysisPage() {
  const [data, setData] = useState<AnalysisResult | null>(null);
  const [funnels, setFunnels] = useState<SegmentFunnels | null>(null);
  const [metrics, setMetrics] = useState<MetricsResp | null>(null);
  const [model, setModel] = useState<LRModel | null>(null);
  const [insights, setInsights] = useState<InsightsResp | null>(null);
  const [showRawTables, setShowRawTables] = useState(false);
  const [reps, setReps] = useState<Rep[]>([]);
  const [repFilter, setRepFilter] = useState<string>("all");
  const [lookback, setLookback] = useState<string>("all");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/sales-reps")
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d?.reps)) setReps(d.reps);
        else if (Array.isArray(d)) setReps(d);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (repFilter !== "all") params.set("repId", repFilter);
    if (lookback !== "all") params.set("days", lookback);
    Promise.all([
      fetch(`/api/analysis?${params}`).then((r) => r.json()),
      fetch(`/api/analysis/segments?${params}`).then((r) => r.json()),
      fetch(`/api/metrics`).then((r) => r.json()),
      fetch(`/api/scorer/conversion-model`).then((r) => r.json()).catch(() => ({ model: null })),
      fetch(`/api/analysis/insights?${params}`).then((r) => r.json()).catch(() => null),
    ])
      .then(([a, f, m, mod, ins]) => {
        setData(a);
        setFunnels(f);
        setMetrics(m);
        setModel(mod?.model ?? null);
        setInsights(ins ?? null);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [repFilter, lookback]);

  const takeaways = useMemo(() => generateTakeaways(data, model), [data, model]);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
          <h1 className="page-title">Analysis</h1>
          <span className="lead-count">Funnel · per-segment lift · learned predictor</span>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {data?.scopeMeta.isAdmin && (
            <select
              value={repFilter}
              onChange={(e) => setRepFilter(e.target.value)}
              className="select"
              style={{ padding: "6px 10px" }}
            >
              <option value="all">Org-wide</option>
              {reps.map((r) => (
                <option key={r.id} value={String(r.id)}>{r.name}</option>
              ))}
            </select>
          )}
          <select
            value={lookback}
            onChange={(e) => setLookback(e.target.value)}
            className="select"
            style={{ padding: "6px 10px" }}
          >
            <option value="all">All-time</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
          </select>
        </div>
      </div>

      {loading && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-secondary)" }}>
          <Loader2 className="spin" style={{ width: 16, height: 16 }} />
          loading…
        </div>
      )}

      {!loading && data && (
        <>
          {/* ── Hero: one sentence + a single number ── */}
          <Hero data={data} insights={insights} />

          {/* ── 3 question cards: winning / losing / changed ── */}
          {insights && <QuestionCards insights={insights} funnels={funnels} />}

          {/* ── Rates by segment — quick-look table for the 3 dimensions
              users actually ask about (lead tier, geo, direction). ── */}
          {funnels && <RatesBySegment funnels={funnels} />}

          {/* ── Segment scatter (the strategic quadrant view) ── */}
          {funnels && <SegmentFunnelsSection funnels={funnels} />}

          {data.totalSent < 10 && (
            <div style={{ padding: 12, marginBottom: 16, border: "1px solid var(--border-light)", borderRadius: 6, background: "var(--bg-subtle)", display: "flex", gap: 10, alignItems: "flex-start" }}>
              <Info style={{ width: 16, height: 16, color: "var(--text-tertiary)", marginTop: 2 }} />
              <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                Only {data.totalSent} sent in this scope — segment lifts will be noisy until ~50+ sends per slice.
              </div>
            </div>
          )}

          {/* ── Funnel waterfall (kept — it's a single clear chart) ── */}
          {metrics && (
            <FunnelWaterfall metrics={metrics} totalReplied={data.totalReplied} />
          )}

          {/* ── Raw tables collapsed by default — power users only ── */}
          <div style={{ marginTop: 24, marginBottom: 16 }}>
            <button
              onClick={() => setShowRawTables((s) => !s)}
              style={{
                background: "transparent",
                border: "1px solid var(--border-light)",
                borderRadius: 6,
                padding: "6px 12px",
                fontSize: 12,
                color: "var(--text-secondary)",
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <Filter style={{ width: 12, height: 12 }} />
              {showRawTables ? "Hide" : "Show"} raw dimension tables + model card
            </button>
          </div>

          {showRawTables && (
            <>
              {takeaways.length > 0 && (
                <div style={{
                  padding: 14,
                  border: "1px solid var(--border-light)",
                  borderRadius: 8,
                  background: "var(--bg-subtle, #fafafa)",
                  marginBottom: 20,
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>
                    <Zap style={{ width: 13, height: 13 }} /> Auto-generated takeaways (legacy view)
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, lineHeight: 1.7, color: "var(--text)" }}>
                    {takeaways.map((t, i) => (
                      <li key={i}>{t}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 20, alignItems: "flex-start" }}>
                <div>
                  <div style={{ fontSize: 13, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
                    <Filter style={{ width: 13, height: 13 }} /> Per-segment WeChat lift (vs {fmtPct(data.baselineWechatRate)} baseline)
                  </div>
                  {data.dimensions.filter((d) => d.hasSignal && d.buckets.some((b) => !b.lowN)).length === 0 ? (
                    <EmptyDimHint baseline={data.baselineWechatRate} totalSent={data.totalSent} />
                  ) : (
                    data.dimensions
                      .filter((d) => d.hasSignal)
                      .map((dim) => (
                        <DimensionLift
                          key={dim.dimension}
                          dim={dim}
                          baselineWechat={data.baselineWechatRate}
                        />
                      ))
                  )}
                </div>

                <ModelCard model={model} />
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

/* ───────────────────────── Hero + Question Cards ──────────────────────────
 * The redesign's bottom-line-up-top: instead of a stats dump, the user
 * lands on (a) one sentence that answers "where am I?" with a single
 * hero number, and (b) three question-shaped cards that each carry an
 * action button. Charts and dimension tables are still here, just
 * pushed below the narrative + collapsed behind a toggle.
 * ─────────────────────────────────────────────────────────────────────────── */

function Hero({ data, insights }: { data: AnalysisResult; insights: InsightsResp | null }) {
  // Headline metric: WeChat conversion rate (the one number that
  // matters for compute-program outreach). Delta sentence comes from
  // insights.headlineDrop when available.
  const conv = data.baselineWechatRate;
  const drop = insights?.headlineDrop;
  let deltaSentence: string | null = null;
  let deltaTone: "up" | "down" | "flat" | "noise" = "flat";
  if (drop && "ratioChange" in drop && !drop.noise) {
    const pp = (drop.curRate - drop.prevRate) * 100;
    const metricLabel = drop.metric === "click_rate" ? "Click rate" : "WeChat rate";
    if (Math.abs(pp) < 0.5) {
      deltaSentence = `${metricLabel} flat vs prev ${drop.windowDays}d (~${(drop.curRate * 100).toFixed(1)}%).`;
      deltaTone = "flat";
    } else if (pp > 0) {
      deltaSentence = `${metricLabel} up ${pp.toFixed(1)}pp vs prev ${drop.windowDays}d → ${(drop.curRate * 100).toFixed(1)}%.`;
      deltaTone = "up";
    } else {
      deltaSentence = `${metricLabel} down ${Math.abs(pp).toFixed(1)}pp vs prev ${drop.windowDays}d → ${(drop.curRate * 100).toFixed(1)}%.`;
      deltaTone = "down";
    }
  } else if (drop && "noise" in drop && drop.noise) {
    deltaSentence = `Not enough volume in the last ${drop.windowDays}d to call a trend.`;
    deltaTone = "noise";
  }

  const toneColor =
    deltaTone === "up"
      ? "#10B981"
      : deltaTone === "down"
        ? "#EF4444"
        : deltaTone === "noise"
          ? "var(--text-tertiary)"
          : "var(--text-secondary)";

  return (
    <div
      style={{
        padding: "24px 28px",
        border: "1px solid var(--border-light)",
        borderRadius: 12,
        background: "linear-gradient(135deg, rgba(99,102,241,0.04) 0%, rgba(236,72,153,0.03) 100%)",
        marginBottom: 20,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 24,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: 11,
            color: "var(--text-tertiary)",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            marginBottom: 4,
          }}
        >
          WeChat conversion (lifetime, this scope)
        </div>
        <div style={{ fontSize: 40, fontWeight: 700, color: "var(--text)", lineHeight: 1.1 }}>
          {fmtPct(conv)}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 4 }}>
          {fmtNum(data.totalWechat)} wechat / {fmtNum(data.totalSent)} sent
        </div>
      </div>
      {deltaSentence && (
        <div style={{ flex: 1, textAlign: "right", minWidth: 0 }}>
          <div style={{ fontSize: 14, color: toneColor, fontWeight: 500, lineHeight: 1.5 }}>
            {deltaSentence}
          </div>
          {drop && "cards" in drop && drop.cards.length > 0 && (
            <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 6 }}>
              top driver: {drop.cards[0].covariate.replace(/_/g, " ")} shifted{" "}
              {drop.cards[0].biggestShift.deltaPct >= 0 ? "+" : ""}
              {drop.cards[0].biggestShift.deltaPct.toFixed(0)}pp toward "
              {drop.cards[0].biggestShift.bucket}"
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function QuestionCards({
  insights,
  funnels,
}: {
  insights: InsightsResp;
  funnels: SegmentFunnels | null;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(3, 1fr)",
        gap: 14,
        marginBottom: 24,
      }}
    >
      <Card
        question="Where am I winning?"
        body={
          insights.winning ? (
            <WinningBody seg={insights.winning} totals={funnels?.totals} />
          ) : (
            <Empty text="No segment has enough volume + signal yet. Send more across more segments." />
          )
        }
      />
      <Card
        question="Where am I losing?"
        body={
          insights.losing ? (
            <LosingBody seg={insights.losing} totals={funnels?.totals} />
          ) : (
            <Empty text="No segment is dragging the funnel down — every slice is on or above baseline." />
          )
        }
      />
      <Card
        question="What changed this week?"
        body={
          insights.headlineDrop && "noise" in insights.headlineDrop && insights.headlineDrop.noise ? (
            <Empty text="Not enough volume in the last 7d to call a trend. Send more, then come back." />
          ) : insights.headlineDrop && "cards" in insights.headlineDrop ? (
            <ChangeBody drop={insights.headlineDrop} />
          ) : (
            <Empty text="No usable signal — try a longer lookback window above." />
          )
        }
      />
    </div>
  );
}

function Card({ question, body }: { question: string; body: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "14px 16px",
        border: "1px solid var(--border-light)",
        borderRadius: 10,
        background: "var(--card, #fff)",
        display: "flex",
        flexDirection: "column",
        minHeight: 180,
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: "var(--text-tertiary)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          marginBottom: 10,
        }}
      >
        {question}
      </div>
      <div style={{ flex: 1 }}>{body}</div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div
      style={{
        fontSize: 12,
        color: "var(--text-tertiary)",
        fontStyle: "italic",
        padding: "20px 0",
      }}
    >
      {text}
    </div>
  );
}

function WinningBody({ seg, totals }: { seg: InsightSegment; totals?: SegmentFunnels["totals"] }) {
  const baseline = totals?.overallPostClick ?? 0;
  const lift = baseline > 0 ? seg.postClickConv / baseline : 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{seg.segment}</div>
      <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{seg.dimension}</div>
      <div style={{ display: "flex", gap: 12, fontSize: 13, marginTop: 4 }}>
        <Stat label="click→wechat" value={fmtPct(seg.postClickConv)} highlight color="#10B981" />
        <Stat label="vs baseline" value={lift > 0 ? `${lift.toFixed(1)}×` : "—"} />
        <Stat label="delivered" value={fmtNum(seg.delivered)} />
      </div>
      <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 6, lineHeight: 1.5 }}>
        Double down here. The body/CTA already converts curiosity at this rate — find more leads that look like this segment.
      </div>
    </div>
  );
}

function LosingBody({ seg, totals }: { seg: InsightSegment; totals?: SegmentFunnels["totals"] }) {
  const baseline = totals?.overallCtr ?? 0;
  const ratio = baseline > 0 ? seg.ctr / baseline : 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{seg.segment}</div>
      <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{seg.dimension}</div>
      <div style={{ display: "flex", gap: 12, fontSize: 13, marginTop: 4 }}>
        <Stat label="CTR" value={fmtPct(seg.ctr)} highlight color="#EF4444" />
        <Stat label="vs baseline" value={ratio > 0 ? `${ratio.toFixed(2)}×` : "—"} />
        <Stat label="delivered" value={fmtNum(seg.delivered)} />
      </div>
      <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 6, lineHeight: 1.5 }}>
        Subject + opener aren&rsquo;t earning the click here. Either rewrite the hook for this segment, or deprioritise it.
      </div>
    </div>
  );
}

function ChangeBody({ drop }: { drop: DiagnoseResult }) {
  const top = drop.cards[0];
  const metricLabel = drop.metric === "click_rate" ? "Click rate" : "WeChat rate";
  const direction = drop.curRate >= drop.prevRate ? "up" : "down";
  const pp = ((drop.curRate - drop.prevRate) * 100).toFixed(1);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
        {metricLabel} {direction} {pp}pp
      </div>
      <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
        {fmtPct(drop.prevRate)} → {fmtPct(drop.curRate)} (last {drop.windowDays}d vs prev)
      </div>
      {top ? (
        <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 6, lineHeight: 1.5 }}>
          Most likely driver:{" "}
          <strong style={{ color: "var(--text)" }}>{top.covariate.replace(/_/g, " ")}</strong>
          &nbsp;— &ldquo;{top.biggestShift.bucket}&rdquo; share moved{" "}
          {top.biggestShift.deltaPct >= 0 ? "+" : ""}
          {top.biggestShift.deltaPct.toFixed(0)}pp.
        </div>
      ) : (
        <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 6 }}>
          No single covariate explains the move &gt;5pp.
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  highlight,
  color,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  color?: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <span style={{ fontSize: 10, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {label}
      </span>
      <span
        style={{
          fontSize: 14,
          fontWeight: highlight ? 700 : 500,
          color: color ?? "var(--text)",
        }}
      >
        {value}
      </span>
    </div>
  );
}

/* ─────────────────────── Rates by segment table ─────────────────────────
 * Compact 3-column view of the dimensions users ask about most:
 * lead tier (strong/normal), geo (CN/overseas), direction. Each row
 * shows delivered / CTR / click→wechat / end-to-end with rates
 * tone-colored vs the org-wide baseline. Buckets with <5 delivered
 * are hidden as noise; (no lead data) is included because — at least
 * for the lead_tier dimension today — it's the bulk of the volume.
 * ────────────────────────────────────────────────────────────────────────── */

function RatesBySegment({ funnels }: { funnels: SegmentFunnels }) {
  const dims: Array<{ key: string; label: string; sortBy: "endToEnd" | "delivered" }> = [
    { key: "geo_binary", label: "Geo (CN vs overseas)", sortBy: "delivered" },
    { key: "lead_tier", label: "Lead tier (strong / normal)", sortBy: "endToEnd" },
    { key: "direction", label: "Top directions", sortBy: "delivered" },
  ];
  const baselineCtr = funnels.totals.overallCtr;
  const baselineConv = funnels.totals.overallPostClick;

  return (
    <div className="section-card" style={{ padding: 16, marginBottom: 14 }}>
      <h3 style={{ marginBottom: 4, fontSize: 14, fontWeight: 600 }}>Rates by segment</h3>
      <p style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 14 }}>
        Org baseline: {fmtPct(baselineCtr)} CTR · {fmtPct(baselineConv)} click→wechat. Cells colored vs baseline.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
        {dims.map((d) => {
          const dim = funnels.dimensions.find((x) => x.dimension === d.key);
          if (!dim) return null;
          // Drop sub-5 delivered noise. Then sort by chosen criterion
          // descending so the most-volume / most-converting bucket
          // appears first.
          const rows = dim.segments
            .filter((s) => s.delivered >= 5)
            .slice()
            .sort((a, b) => (b[d.sortBy] as number) - (a[d.sortBy] as number))
            .slice(0, d.key === "direction" ? 6 : 8);
          return (
            <div key={d.key}>
              <div style={{ fontSize: 11, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 600, marginBottom: 6 }}>
                {d.label}
              </div>
              {rows.length === 0 ? (
                <div style={{ fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic" }}>
                  no segment has ≥5 delivered yet
                </div>
              ) : (
                <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ color: "var(--text-tertiary)" }}>
                      <th style={{ textAlign: "left", padding: "3px 4px", fontWeight: 500 }}>Segment</th>
                      <th style={{ textAlign: "right", padding: "3px 4px", fontWeight: 500 }}>n</th>
                      <th style={{ textAlign: "right", padding: "3px 4px", fontWeight: 500 }}>CTR</th>
                      <th style={{ textAlign: "right", padding: "3px 4px", fontWeight: 500 }}>→wc</th>
                      <th style={{ textAlign: "right", padding: "3px 4px", fontWeight: 500 }}>e2e</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((s) => (
                      <tr key={s.segment} style={{ borderTop: "1px solid var(--border-light)", opacity: s.lowN ? 0.6 : 1 }}>
                        <td style={{ padding: "5px 4px", color: "var(--text)", maxWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.segment}>
                          {s.segment}
                        </td>
                        <td style={{ padding: "5px 4px", textAlign: "right", color: "var(--text-secondary)", fontFamily: "ui-monospace, monospace" }}>
                          {s.delivered}
                        </td>
                        <td style={{ padding: "5px 4px", textAlign: "right", color: rateTone(s.ctr, baselineCtr), fontWeight: 500, fontFamily: "ui-monospace, monospace" }}>
                          {fmtPct(s.ctr)}
                        </td>
                        <td style={{ padding: "5px 4px", textAlign: "right", color: rateTone(s.postClickConv, baselineConv), fontWeight: 500, fontFamily: "ui-monospace, monospace" }}>
                          {fmtPct(s.postClickConv)}
                        </td>
                        <td style={{ padding: "5px 4px", textAlign: "right", color: "var(--text-secondary)", fontFamily: "ui-monospace, monospace" }}>
                          {fmtPct(s.endToEnd)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function rateTone(rate: number, baseline: number): string {
  // Symmetric ±20% threshold around baseline before coloring; under
  // that, treat as "near baseline" and stay neutral. Matches the
  // SegmentScatter quadrant logic so colors are consistent across
  // the page.
  if (baseline <= 0 || rate === 0) return "var(--text-secondary)";
  const ratio = rate / baseline;
  if (ratio >= 1.2) return "#16a34a";
  if (ratio <= 0.8) return "#dc2626";
  return "var(--text-secondary)";
}

/* ─────────────────── Segment funnels (two-stage) ─────────────────── */

function SegmentFunnelsSection({ funnels }: { funnels: SegmentFunnels }) {
  // Lead with the binary geo comparison if it has data — that's the
  // most actionable single chart on this page.
  const geoBinary = funnels.dimensions.find((d) => d.dimension === "geo_binary");
  const others = funnels.dimensions.filter((d) => d.dimension !== "geo_binary");

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        fontSize: 13, color: "var(--text-tertiary)",
        textTransform: "uppercase", letterSpacing: "0.04em",
        marginBottom: 10,
      }}>
        <GitCompare style={{ width: 13, height: 13 }} />
        Two-stage funnel by segment — CTR (top of funnel) vs click→WeChat (bottom)
      </div>
      <p style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 14, lineHeight: 1.6 }}>
        High CTR + low click-conv = opener works, body/CTA doesn&rsquo;t convert curiosity (rewrite the pitch).
        Low CTR + high click-conv = audience is qualified, opener doesn&rsquo;t earn the click (rewrite the subject + first line).
        Same end-to-end rate can come from very different problems.
      </p>

      {geoBinary && geoBinary.segments.length >= 2 && (
        <GeoComparison segments={geoBinary.segments} totals={funnels.totals} />
      )}

      <SegmentScatter funnels={funnels} />

      {others.map((dim) => (
        <SegmentMatrix key={dim.dimension} dim={dim} totals={funnels.totals} />
      ))}
    </div>
  );
}

function SegmentScatter({ funnels }: { funnels: SegmentFunnels }) {
  // Strategic-quadrant view: every (dimension, segment) becomes one
  // dot positioned by (CTR, post-click conv). The four quadrants tell
  // you what to do, not just what's true:
  //   top-right    — high CTR + high conv → 金矿, scale this segment
  //   bottom-right — high CTR + low conv  → subject 误导, body fails
  //   top-left     — low CTR + high conv  → opener gap, body works
  //   bottom-left  — low + low → 别浪费 time on this segment
  // Dot size is delivered count so noise (lowN) shrinks visually.
  const data = useMemo(() => {
    const rows: { dimension: string; segment: string; ctr: number; conv: number; delivered: number; lowN: boolean }[] = [];
    for (const dim of funnels.dimensions) {
      for (const seg of dim.segments) {
        if (seg.delivered < 5) continue; // hard floor — anything smaller is just noise
        rows.push({
          dimension: dim.label,
          segment: seg.segment,
          ctr: seg.ctr,
          conv: seg.postClickConv,
          delivered: seg.delivered,
          lowN: seg.lowN,
        });
      }
    }
    return rows;
  }, [funnels]);

  if (data.length === 0) return null;

  const overallCtr = funnels.totals.overallCtr;
  const overallConv = funnels.totals.overallPostClick;

  return (
    <div className="section-card" style={{ padding: 16, marginBottom: 14 }}>
      <h3 style={{ marginBottom: 4, fontSize: 14, fontWeight: 600 }}>
        Segment strategy quadrants
      </h3>
      <p style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 12 }}>
        Each dot = one segment. X = CTR (subject + opener earn the click), Y = click→WeChat
        conversion (body + CTA hold the interest). Dashed lines = overall baseline. Top-right = goldmine;
        bottom-right = subject mis-sells (clicks but no follow-through); top-left = weak subject but right content;
        bottom-left = don&rsquo;t waste time.
      </p>
      <div style={{ width: "100%", height: 320 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 10, right: 30, bottom: 36, left: 36 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" />
            <XAxis
              type="number"
              dataKey="ctr"
              name="CTR"
              domain={[0, "auto"]}
              tickFormatter={(v) => `${(v * 100).toFixed(1)}%`}
              label={{ value: "CTR (clicked / delivered)", position: "insideBottom", offset: -8, style: { fontSize: 11, fill: "var(--text-secondary)" } }}
              tick={{ fontSize: 10 }}
            />
            <YAxis
              type="number"
              dataKey="conv"
              name="post-click conv"
              domain={[0, "auto"]}
              tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
              label={{ value: "click → WeChat", angle: -90, position: "insideLeft", style: { fontSize: 11, fill: "var(--text-secondary)" } }}
              tick={{ fontSize: 10 }}
            />
            <ZAxis type="number" dataKey="delivered" range={[40, 400]} name="sample size" />
            <ReferenceLine x={overallCtr} stroke="var(--text-tertiary)" strokeDasharray="3 3" />
            <ReferenceLine y={overallConv} stroke="var(--text-tertiary)" strokeDasharray="3 3" />
            <RechartsTooltip
              cursor={{ strokeDasharray: "3 3" }}
              content={({ active, payload }) => {
                if (!active || !payload || payload.length === 0) return null;
                const d = payload[0].payload as typeof data[number];
                return (
                  <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, padding: 10, fontSize: 12 }}>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>{d.segment}</div>
                    <div style={{ color: "var(--text-secondary)", marginBottom: 6 }}>{d.dimension}</div>
                    <div>CTR: <strong>{(d.ctr * 100).toFixed(1)}%</strong></div>
                    <div>Click→WeChat: <strong>{(d.conv * 100).toFixed(1)}%</strong></div>
                    <div style={{ color: "var(--text-tertiary)", marginTop: 4 }}>{d.delivered} delivered{d.lowN ? " · low N" : ""}</div>
                  </div>
                );
              }}
            />
            <Scatter data={data} fill="#6366F1" fillOpacity={0.7} stroke="#4338CA" />
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function GeoComparison({ segments, totals }: { segments: SegmentStats[]; totals: SegmentFunnels["totals"] }) {
  // Side-by-side mini-funnels — Domestic .cn vs Overseas. The visual is
  // two stacked horizontal funnels so the eye reads "where they win/lose"
  // without parsing numbers. Bars normalized within each segment so the
  // shape comparison is honest even if one segment is much smaller.
  const dom = segments.find((s) => s.segment === "Domestic (.cn)");
  const ovs = segments.find((s) => s.segment === "Overseas");
  if (!dom || !ovs) return null;

  return (
    <div style={{
      padding: 16, marginBottom: 16,
      border: "1px solid var(--border-light)", borderRadius: 8,
    }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <SegmentFunnelCard seg={dom} accent="#16a34a" />
        <SegmentFunnelCard seg={ovs} accent="#3b82f6" />
      </div>
      <Diagnosis dom={dom} ovs={ovs} totals={totals} />
    </div>
  );
}

function SegmentFunnelCard({ seg, accent }: { seg: SegmentStats; accent: string }) {
  const max = Math.max(seg.delivered, 1);
  const stages = [
    { label: "Delivered", value: seg.delivered },
    { label: "Clicked", value: seg.clicked },
    { label: "WeChat", value: seg.wechat },
  ];
  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
        <h3 style={{ marginBottom: 0, fontSize: 14 }}>{seg.segment}</h3>
        {seg.lowN && <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>(low N)</span>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {stages.map((s) => {
          const w = (s.value / max) * 100;
          return (
            <div key={s.label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 70, fontSize: 11, color: "var(--text-secondary)" }}>{s.label}</div>
              <div style={{ flex: 1, height: 18, background: "var(--bg-subtle, #f4f4f5)", borderRadius: 3, position: "relative", overflow: "hidden" }}>
                <div style={{ width: `${w}%`, height: "100%", background: accent, transition: "width 200ms ease" }} />
                <div style={{
                  position: "absolute", top: 0, left: 6, right: 6, bottom: 0,
                  display: "flex", alignItems: "center",
                  fontSize: 11, color: w > 25 ? "white" : "var(--text)", fontWeight: 600,
                }}>
                  {s.value}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div style={{
        marginTop: 10, padding: "8px 10px",
        background: "var(--bg-subtle, #f9fafb)",
        borderRadius: 4, fontSize: 12, lineHeight: 1.7,
      }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ color: "var(--text-secondary)" }}>CTR (clicked / delivered)</span>
          <strong>{(seg.ctr * 100).toFixed(1)}%</strong>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ color: "var(--text-secondary)" }}>Click → WeChat</span>
          <strong>{(seg.postClickConv * 100).toFixed(1)}%</strong>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid var(--border-light)", marginTop: 4, paddingTop: 4 }}>
          <span style={{ color: "var(--text-secondary)" }}>End-to-end</span>
          <strong>{(seg.endToEnd * 100).toFixed(2)}%</strong>
        </div>
      </div>
    </div>
  );
}

function Diagnosis({ dom, ovs, totals }: { dom: SegmentStats; ovs: SegmentStats; totals: SegmentFunnels["totals"] }) {
  // Auto-generated reading of the comparison — this is what makes the
  // visualization actionable rather than just pretty.
  const ctrRatio = ovs.ctr > 0 && dom.ctr > 0 ? Math.max(ovs.ctr, dom.ctr) / Math.min(ovs.ctr, dom.ctr) : 0;
  const convRatio = ovs.postClickConv > 0 && dom.postClickConv > 0
    ? Math.max(ovs.postClickConv, dom.postClickConv) / Math.min(ovs.postClickConv, dom.postClickConv) : 0;
  const ctrWinner = ovs.ctr > dom.ctr ? "overseas" : "domestic";
  const convWinner = ovs.postClickConv > dom.postClickConv ? "overseas" : "domestic";
  const sentencesEn: string[] = [];

  if (ctrRatio >= 1.3 || convRatio >= 1.3) {
    if (ctrWinner !== convWinner) {
      sentencesEn.push(`The two audiences win at opposite ends of the funnel: ${ctrWinner} clicks ${ctrRatio.toFixed(1)}× more, but ${convWinner} converts ${convRatio.toFixed(1)}× more after clicking.`);
    } else {
      sentencesEn.push(`${ctrWinner === "overseas" ? "Overseas" : "Domestic"} wins both stages — ${ctrRatio.toFixed(1)}× CTR and ${convRatio.toFixed(1)}× post-click. Look at what differs in tone or pitch and apply it to the other audience.`);
    }
  }
  if (ovs.ctr > dom.ctr * 1.5 && dom.postClickConv > ovs.postClickConv * 1.5) {
    sentencesEn.push("Implication: overseas drafts need a tighter body+CTA (curiosity → commitment); domestic drafts need a stronger opener + subject (earn the click).");
  }

  if (sentencesEn.length === 0) return null;
  return (
    <div style={{ marginTop: 12, padding: 12, border: "1px solid var(--border-light)", borderRadius: 6, background: "var(--bg-subtle, #fafafa)" }}>
      <div style={{ fontSize: 11, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6, display: "flex", alignItems: "center", gap: 4 }}>
        <Zap style={{ width: 12, height: 12 }} /> Reading
      </div>
      {sentencesEn.map((s, i) => (
        <p key={`en-${i}`} style={{ fontSize: 12.5, lineHeight: 1.6, marginBottom: 4 }}>{s}</p>
      ))}
    </div>
  );
}

function SegmentMatrix({ dim, totals }: { dim: SegmentDim; totals: SegmentFunnels["totals"] }) {
  // For non-binary dimensions: a compact matrix table with both rates
  // colored relative to the org baseline. Easier to scan than two
  // separate bar charts.
  const visible = dim.segments.filter((s) => !s.lowN || s.delivered >= 5);
  if (visible.length === 0) return null;

  return (
    <div style={{ padding: 14, marginBottom: 14, border: "1px solid var(--border-light)", borderRadius: 8 }}>
      <h3 style={{ marginBottom: 10, fontSize: 14 }}>{dim.label}</h3>
      <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ color: "var(--text-tertiary)", textAlign: "left" }}>
            <th style={{ padding: "4px 6px" }}>Segment</th>
            <th style={{ padding: "4px 6px", textAlign: "right" }}>Delivered</th>
            <th style={{ padding: "4px 6px", textAlign: "right" }}>Clicked</th>
            <th style={{ padding: "4px 6px", textAlign: "right" }}>WeChat</th>
            <th style={{ padding: "4px 6px", textAlign: "right" }}>CTR</th>
            <th style={{ padding: "4px 6px", textAlign: "right" }}>Click→WC</th>
            <th style={{ padding: "4px 6px", textAlign: "right" }}>End-to-end</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((s) => {
            const ctrColor = s.lowN ? "var(--text-tertiary)"
              : s.ctr >= totals.overallCtr * 1.3 ? "#16a34a"
              : s.ctr <= totals.overallCtr * 0.5 ? "#dc2626" : undefined;
            const convColor = s.lowN ? "var(--text-tertiary)"
              : s.postClickConv >= totals.overallPostClick * 1.3 ? "#16a34a"
              : s.postClickConv <= totals.overallPostClick * 0.5 ? "#dc2626" : undefined;
            return (
              <tr key={s.segment} style={{ borderTop: "1px solid var(--border-light)", opacity: s.lowN ? 0.65 : 1 }}>
                <td style={{ padding: "5px 6px" }}>{s.segment}</td>
                <td style={{ padding: "5px 6px", textAlign: "right" }}>{s.delivered}</td>
                <td style={{ padding: "5px 6px", textAlign: "right" }}>{s.clicked}</td>
                <td style={{ padding: "5px 6px", textAlign: "right" }}>{s.wechat}</td>
                <td style={{ padding: "5px 6px", textAlign: "right", color: ctrColor, fontWeight: ctrColor ? 600 : undefined }}>{(s.ctr * 100).toFixed(1)}%</td>
                <td style={{ padding: "5px 6px", textAlign: "right", color: convColor, fontWeight: convColor ? 600 : undefined }}>{(s.postClickConv * 100).toFixed(1)}%</td>
                <td style={{ padding: "5px 6px", textAlign: "right", color: "var(--text-secondary)" }}>{(s.endToEnd * 100).toFixed(2)}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ─────────────────── Funnel waterfall ─────────────────── */

function FunnelWaterfall({ metrics, totalReplied }: { metrics: MetricsResp; totalReplied: number }) {
  const stages = [
    { label: "Sent", value: metrics.overview.totalSent, color: "#3b82f6" },
    { label: "Delivered", value: metrics.overview.totalDelivered, color: "#10b981" },
    { label: "Clicked", value: metrics.overview.totalClicked, color: "#8b5cf6" },
    { label: "Replied", value: totalReplied, color: "#f59e0b" },
    { label: "WeChat", value: metrics.wechat.total, color: "#16a34a" },
  ];
  const max = stages[0].value || 1;
  return (
    <div style={{ marginBottom: 24, padding: 16, border: "1px solid var(--border-light)", borderRadius: 8 }}>
      <div style={{ fontSize: 13, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 12 }}>
        Funnel
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {stages.map((s, i) => {
          const widthPct = max > 0 ? (s.value / max) * 100 : 0;
          const dropPct = i > 0 && stages[i - 1].value > 0
            ? ((stages[i - 1].value - s.value) / stages[i - 1].value) * 100
            : 0;
          return (
            <div key={s.label} style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 90, fontSize: 12, color: "var(--text-secondary)", fontWeight: 500 }}>{s.label}</div>
              <div style={{ flex: 1, position: "relative", height: 26, background: "var(--bg-subtle, #f4f4f5)", borderRadius: 4, overflow: "hidden" }}>
                <div
                  style={{
                    width: `${widthPct}%`,
                    height: "100%",
                    background: s.color,
                    transition: "width 200ms ease",
                  }}
                />
                <div style={{
                  position: "absolute",
                  top: 0, left: 8, right: 8, bottom: 0,
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  fontSize: 12, color: widthPct > 30 ? "white" : "var(--text)", fontWeight: 600,
                  pointerEvents: "none",
                }}>
                  <span>{fmtNum(s.value)}</span>
                  {i > 0 && (
                    <span style={{ fontSize: 11, opacity: 0.85 }}>
                      −{dropPct.toFixed(1)}% drop
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─────────────────── Lift bars per dimension ─────────────────── */

function DimensionLift({ dim, baselineWechat }: { dim: DimensionBreakdown; baselineWechat: number }) {
  // Compute lift per bucket; sort by lift desc; clamp visualisation to a
  // fixed range so a 10× outlier doesn't squash the rest.
  const enriched = dim.buckets
    .filter((b) => !b.lowN)
    .map((b) => {
      const lift = baselineWechat > 0 && Number.isFinite(b.wechatRate)
        ? b.wechatRate / baselineWechat
        : 0;
      return { ...b, lift };
    })
    .sort((a, b) => b.lift - a.lift);

  if (enriched.length === 0) return null;

  // Map lift to bar width (center=50%, full bar = lift in [0, 4]).
  const maxLiftCap = 4;
  const widthOf = (lift: number) => Math.min(lift, maxLiftCap) / maxLiftCap * 50;
  const barColor = (lift: number) => {
    if (lift >= 1.5) return "#16a34a";
    if (lift <= 0.5) return "#dc2626";
    return "#94a3b8";
  };

  return (
    <div className="section-card" style={{ marginBottom: 16, padding: 14 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
        <h3 style={{ marginBottom: 0, fontSize: 14 }}>{dim.label}</h3>
        <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
          {(dim.coverage * 100).toFixed(0)}% coverage · {dim.totalSent} sent
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {enriched.map((b) => (
          <div
            key={b.bucket}
            title={`${b.bucket}\nPopulation: ${b.population}\nSent: ${b.sent} | Replied: ${b.replied} | WeChat: ${b.wechat}\nReply rate: ${fmtPct(b.replyRate)} | WeChat rate: ${fmtPct(b.wechatRate)}\nLift: ${b.lift.toFixed(2)}×`}
            style={{ display: "grid", gridTemplateColumns: "180px 1fr 80px", gap: 8, alignItems: "center", fontSize: 12 }}
          >
            <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {b.bucket}
              <span style={{ color: "var(--text-tertiary)", marginLeft: 6, fontSize: 11 }}>n={b.sent}</span>
            </div>
            <div style={{ position: "relative", height: 14, background: "transparent" }}>
              {/* center line */}
              <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: "var(--border)" }} />
              {/* bar */}
              {b.lift >= 1 ? (
                <div style={{
                  position: "absolute", left: "50%", top: 2, bottom: 2,
                  width: `${widthOf(b.lift) - 0}%`,
                  background: barColor(b.lift), borderRadius: "0 3px 3px 0",
                }} />
              ) : (
                <div style={{
                  position: "absolute", right: "50%", top: 2, bottom: 2,
                  width: `${50 - widthOf(b.lift) === 50 ? 0 : 50 - widthOf(b.lift)}%`,
                  background: barColor(b.lift), borderRadius: "3px 0 0 3px",
                }} />
              )}
            </div>
            <div style={{
              textAlign: "right",
              fontVariantNumeric: "tabular-nums",
              fontSize: 12, fontWeight: 500,
              color: barColor(b.lift),
            }}>
              {b.lift.toFixed(2)}×
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function EmptyDimHint({ baseline, totalSent }: { baseline: number; totalSent: number }) {
  return (
    <div className="section-card" style={{ padding: 16, color: "var(--text-secondary)", fontSize: 13 }}>
      Baseline conversion is {fmtPct(baseline)} across {totalSent} sends. No segment shows enough volume yet to be meaningfully above or below — keep sending and segments will start to appear here as their bucket size crosses the noise floor.
    </div>
  );
}

/* ─────────────────── Conversion model card ─────────────────── */

function ModelCard({ model }: { model: LRModel | null }) {
  if (!model) {
    return (
      <div className="section-card" style={{ padding: 14 }}>
        <div style={{ fontSize: 13, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>
          Learned predictor
        </div>
        <p style={{ fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.6 }}>
          No conversion model trained yet. Once enough recipients have clicked or added on WeChat, the scorer page can fit a logistic regression and weights will appear here.
        </p>
        <a href="/scorer" style={{ display: "inline-block", marginTop: 8, fontSize: 12, color: "var(--link, #2563eb)" }}>
          Open /scorer →
        </a>
      </div>
    );
  }
  // Sort features by absolute weight desc.
  const ranked = model.featureNames
    .map((n, i) => ({ name: n, w: model.weights[i] }))
    .sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
  const maxAbs = Math.max(...ranked.map((r) => Math.abs(r.w)), 0.01);

  return (
    <div className="section-card" style={{ padding: 14 }}>
      <div style={{ fontSize: 13, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>
        Learned predictor
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
        <MiniStat label="Held-out AUC" value={model.auc.toFixed(3)} />
        <MiniStat label="Samples" value={`${model.nSamples} · ${model.nPositive}+`} />
      </div>
      {model.label_stats && (
        <div style={{ fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.6, marginBottom: 12, padding: "6px 8px", border: "1px solid var(--border-light)", borderRadius: 4 }}>
          <strong>Labels:</strong> {model.label_stats.wechat} WeChat · {model.label_stats.clicked} clicks
          {model.label_weights && (<> · weights {model.label_weights.wechat}:{model.label_weights.click}:1</>)}
          {model.label_stats.either < 20 && (
            <div style={{ color: "#d97706", marginTop: 4, display: "flex", gap: 4, alignItems: "center" }}>
              <AlertCircle style={{ width: 11, height: 11 }} /> Tiny positive class — directional only.
            </div>
          )}
        </div>
      )}
      <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 6 }}>Feature weights (sorted)</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {ranked.map((r) => {
          const widthPct = (Math.abs(r.w) / maxAbs) * 50;
          const isPos = r.w >= 0;
          const color = Math.abs(r.w) < 0.05 ? "#94a3b8" : isPos ? "#16a34a" : "#dc2626";
          return (
            <div key={r.name} style={{ display: "grid", gridTemplateColumns: "100px 1fr 50px", gap: 6, alignItems: "center", fontSize: 11 }}>
              <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</div>
              <div style={{ position: "relative", height: 10 }}>
                <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: "var(--border)" }} />
                {isPos ? (
                  <div style={{ position: "absolute", left: "50%", top: 1, bottom: 1, width: `${widthPct}%`, background: color, borderRadius: "0 2px 2px 0" }} />
                ) : (
                  <div style={{ position: "absolute", right: "50%", top: 1, bottom: 1, width: `${widthPct}%`, background: color, borderRadius: "2px 0 0 2px" }} />
                )}
              </div>
              <div style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color }}>
                {r.w >= 0 ? "+" : ""}{r.w.toFixed(2)}
              </div>
            </div>
          );
        })}
      </div>
      {model.trained_at && (
        <p style={{ fontSize: 10.5, color: "var(--text-tertiary)", marginTop: 10 }}>
          Trained {new Date(model.trained_at).toLocaleString()}
        </p>
      )}
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ padding: 8, border: "1px solid var(--border-light)", borderRadius: 4 }}>
      <div style={{ fontSize: 10, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 2 }}>{label}</div>
      <div className="mono-num" style={{ fontSize: 14, fontWeight: 500 }}>{value}</div>
    </div>
  );
}

/* ─────────────────── Generated takeaways ─────────────────── */

function generateTakeaways(data: AnalysisResult | null, model: LRModel | null): string[] {
  if (!data) return [];
  const out: string[] = [];

  if (data.totalSent < 50) {
    out.push(`Only ${data.totalSent} sends in this view — segment lifts below are directional, not statistical.`);
  }

  // Top-lift bucket per dimension (only if ≥ 1.5x and not lowN).
  for (const dim of data.dimensions) {
    if (!dim.hasSignal) continue;
    const top = dim.buckets
      .filter((b) => !b.lowN && data.baselineWechatRate > 0)
      .map((b) => ({ ...b, lift: b.wechatRate / data.baselineWechatRate }))
      .sort((a, b) => b.lift - a.lift)[0];
    if (top && top.lift >= 1.5) {
      out.push(`${dim.label}: "${top.bucket}" converts at ${fmtPct(top.wechatRate)} (${top.lift.toFixed(1)}× baseline) on ${top.sent} sends — keep targeting here.`);
    }
    const worst = dim.buckets
      .filter((b) => !b.lowN && data.baselineWechatRate > 0)
      .map((b) => ({ ...b, lift: b.wechatRate / data.baselineWechatRate }))
      .sort((a, b) => a.lift - b.lift)[0];
    if (worst && worst.lift <= 0.5 && worst.sent >= 10) {
      out.push(`${dim.label}: "${worst.bucket}" only converts at ${fmtPct(worst.wechatRate)} (${worst.lift.toFixed(2)}×) on ${worst.sent} sends — consider deprioritising.`);
    }
  }

  if (model && model.label_stats && model.label_stats.either < 20) {
    out.push(`The conversion model is trained on ${model.label_stats.either} positive samples — treat its feature weights as hints, not law.`);
  }

  return out.slice(0, 6);
}
