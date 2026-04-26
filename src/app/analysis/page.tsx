"use client";

import { useEffect, useMemo, useState } from "react";
import { TrendingUp, Loader2, Filter, Info, Zap, AlertCircle, GitCompare } from "lucide-react";

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
    ])
      .then(([a, f, m, mod]) => {
        setData(a);
        setFunnels(f);
        setMetrics(m);
        setModel(mod?.model ?? null);
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
          {/* ── Generated takeaways (bottom-line up top) ── */}
          {takeaways.length > 0 && (
            <div style={{
              padding: 14,
              border: "1px solid var(--border-light)",
              borderRadius: 8,
              background: "var(--bg-subtle, #fafafa)",
              marginBottom: 20,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>
                <Zap style={{ width: 13, height: 13 }} /> Takeaways
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, lineHeight: 1.7, color: "var(--text)" }}>
                {takeaways.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            </div>
          )}

          {/* ── Segment funnels (the headline finding) ── */}
          {funnels && <SegmentFunnelsSection funnels={funnels} />}

          {/* ── Funnel waterfall ── */}
          {metrics && (
            <FunnelWaterfall metrics={metrics} totalReplied={data.totalReplied} />
          )}

          {data.totalSent < 10 && (
            <div style={{ padding: 12, marginBottom: 16, border: "1px solid var(--border-light)", borderRadius: 6, background: "var(--bg-subtle)", display: "flex", gap: 10, alignItems: "flex-start" }}>
              <Info style={{ width: 16, height: 16, color: "var(--text-tertiary)", marginTop: 2 }} />
              <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                Only {data.totalSent} sent in this scope — segment lifts will be noisy until ~50+ sends per slice.
              </div>
            </div>
          )}

          {/* ── Two-column layout: lift bars + model ── */}
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
    </div>
  );
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

      {others.map((dim) => (
        <SegmentMatrix key={dim.dimension} dim={dim} totals={funnels.totals} />
      ))}
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
  const sentencesZh: string[] = [];

  if (ctrRatio >= 1.3 || convRatio >= 1.3) {
    if (ctrWinner !== convWinner) {
      sentencesEn.push(`The two audiences win at opposite ends of the funnel: ${ctrWinner} clicks ${ctrRatio.toFixed(1)}× more, but ${convWinner} converts ${convRatio.toFixed(1)}× more after clicking.`);
      sentencesZh.push(`两个群体的赢点完全不同: ${ctrWinner === "overseas" ? "海外" : "国内"}点击率高 ${ctrRatio.toFixed(1)}×，但${convWinner === "overseas" ? "海外" : "国内"}点击后转化高 ${convRatio.toFixed(1)}×。`);
    } else {
      sentencesEn.push(`${ctrWinner === "overseas" ? "Overseas" : "Domestic"} wins both stages — ${ctrRatio.toFixed(1)}× CTR and ${convRatio.toFixed(1)}× post-click. Look at what differs in tone or pitch and apply it to the other audience.`);
    }
  }
  if (ovs.ctr > dom.ctr * 1.5 && dom.postClickConv > ovs.postClickConv * 1.5) {
    sentencesEn.push("Implication: overseas drafts need a tighter body+CTA (curiosity → commitment); domestic drafts need a stronger opener + subject (earn the click).");
    sentencesZh.push("写邮件的方向: 海外稿件要把正文+CTA 收紧，把好奇心转成行动；国内稿件要把开头和 subject 写得更有钩子，先把点击赚到。");
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
      {sentencesZh.map((s, i) => (
        <p key={`zh-${i}`} style={{ fontSize: 12.5, lineHeight: 1.6, color: "var(--text-secondary)" }}>{s}</p>
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
