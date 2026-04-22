"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Star, TrendingUp, BarChart3, GitCompare, AlertTriangle, Sparkles, Target, Users2, Loader2 } from "lucide-react";
import { EmailQualityTab, ConversionTab, MatchTab, TechMetric, LeadTrainWorkbench, CitationBackfillCard } from "./_tabs";
import {
  BarChart, Bar, LineChart, Line,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell,
} from "recharts";

interface ScorerMeta {
  embedder: string;
  n_samples: number;
  n_positive: number;
  n_negative: number;
  cv_f1_mean: number;
  cv_f1_std: number;
  cv_precision: number;
  cv_recall: number;
  cv_auc: number;
  trained_at: string;
  label_distribution: Record<string, number>;
  score_distribution: { bin: string; count: number }[];
  gemini_vs_scorer: {
    correlation: number;
    mean_gemini: number;
    mean_scorer: number;
    disagreements: { title: string; gemini: number; scorer: number; diff: number; label: number }[];
  };
}

interface HistoryEntry {
  trained_at: string;
  n_samples: number;
  cv_f1: number;
  cv_precision: number;
  cv_recall: number;
  cv_auc: number;
  embedder: string;
}

const TOOLTIP = {
  backgroundColor: "#FFFFFF",
  border: "1px solid var(--border)",
  borderRadius: 8,
  fontSize: 12,
  color: "#1A1A1A",
  boxShadow: "0 4px 12px rgba(0,0,0,0.06)",
};

function MetricCard({
  label,
  value,
  sub,
  emphasis,
}: {
  label: string;
  value: string;
  sub?: string;
  emphasis?: boolean;
}) {
  return (
    <div
      className="stat-card"
      style={emphasis ? { background: "linear-gradient(180deg, var(--card) 0%, var(--bg) 100%)", borderColor: "rgba(10,10,10,0.12)" } : undefined}
    >
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={emphasis ? { fontSize: 34 } : undefined}>{value}</div>
      {sub && <div className="stat-sub neutral">{sub}</div>}
    </div>
  );
}

interface LiveData {
  totalLeads: number;
  scoredLeads: number;
  meanScore: number;
  distribution: { bin: string; count: number }[];
  calibration: { bin: string; sent: number; converted: number; convRate: number }[];
  topPending: { id: string; title: string; score: number; tier: string | null; citations: number | null }[];
  bigMisses: { id: string; title: string; score: number; sentAt: string | null }[];
  hiddenWins: { id: string; title: string; score: number }[];
  byCategory: { name: string; count: number; meanScore: number; sent: number; converted: number; convRate: number }[];
  sourceBreakdown: { pythonScored: number; apiScored: number; unscored: number };
}

type ScorerTab = "lead" | "email" | "conversion" | "match";

export default function ScorerPage() {
  const router = useRouter();
  const [gated, setGated] = useState<"checking" | "allowed" | "forbidden">("checking");
  const [meta, setMeta] = useState<ScorerMeta | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [live, setLive] = useState<LiveData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<ScorerTab>("lead");

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        if (d.authenticated && d.role === "admin") setGated("allowed");
        else { setGated("forbidden"); router.replace("/"); }
      })
      .catch(() => { setGated("forbidden"); router.replace("/"); });
  }, [router]);

  useEffect(() => {
    if (gated !== "allowed") return;
    Promise.all([
      fetch("/api/scorer").then((r) => r.json()),
      fetch("/api/scorer/live").then((r) => r.json()).catch(() => null),
    ])
      .then(([trainData, liveData]) => {
        if (trainData.error) setError(trainData.error);
        else {
          setMeta(trainData.metadata);
          setHistory(trainData.history || []);
        }
        if (liveData && !liveData.error) setLive(liveData);
      })
      .catch(() => setError("Failed to load scorer data"))
      .finally(() => setLoading(false));
  }, [gated]);

  if (gated !== "allowed") {
    // Render nothing while we're redirecting — the router.replace is already in flight.
    return null;
  }

  const trainedDate = meta
    ? new Date(meta.trained_at).toLocaleDateString("en-US", {
        month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit",
      })
    : null;

  const labelData = meta
    ? Object.entries(meta.label_distribution)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => ({ name: k.replace(/_/g, " ").replace(/\d\.\d/, ""), count: v }))
    : [];

  return (
    <div>
      {/* Hero header */}
      <div style={{ position: "relative", marginBottom: 24, paddingBottom: 18, borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20, flexWrap: "wrap" }}>
          <div>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>
              <span className="pulse-dot" />
              Live
              <span style={{ color: "var(--border)", margin: "0 4px" }}>·</span>
              4 scorers online
            </div>
            <h1 className="page-title" style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 30, letterSpacing: "-0.02em" }}>
              Scorer
            </h1>
            <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 6 }}>
              {tab === "lead" ? (meta ? `${meta.embedder} · Trained ${trainedDate}` : "Loading training snapshot…") :
               tab === "email" ? "How human do the AI drafts sound? — LLM ensemble + sales edits" :
               tab === "conversion" ? "Which features predict WeChat conversion?" :
               "Is the right rep handling each lead?"}
            </p>
          </div>
          {loading && (
            <div style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-tertiary)", fontFamily: "ui-monospace, monospace" }}>
              <Loader2 style={{ width: 12, height: 12 }} className="spin" />
              syncing…
            </div>
          )}
        </div>
      </div>

      {/* Tab nav */}
      <div style={{ display: "flex", gap: 4, marginBottom: 24, borderBottom: "1px solid var(--border)" }}>
        <ScorerTabBtn active={tab === "lead"} onClick={() => setTab("lead")} icon={<Star style={{ width: 14, height: 14 }} />} label="Lead quality" />
        <ScorerTabBtn active={tab === "email"} onClick={() => setTab("email")} icon={<Sparkles style={{ width: 14, height: 14 }} />} label="Email quality" />
        <ScorerTabBtn active={tab === "conversion"} onClick={() => setTab("conversion")} icon={<Target style={{ width: 14, height: 14 }} />} label="Conversion" />
        <ScorerTabBtn active={tab === "match"} onClick={() => setTab("match")} icon={<Users2 style={{ width: 14, height: 14 }} />} label="Sales match" />
      </div>

      {tab === "email" && <EmailQualityTab />}
      {tab === "conversion" && <ConversionTab />}
      {tab === "match" && <MatchTab />}
      {tab === "lead" && (
        loading ? <LeadQualityLoading /> :
        error ? <LeadQualityError err={error} /> :
        !meta ? <LeadQualityMissing /> :
        <LeadQualityView meta={meta} history={history} live={live} labelData={labelData} />
      )}
    </div>
  );
}

function LeadQualityLoading() {
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 20 }}>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="metric-tech" style={{ height: 104 }}>
            <div className="metric-label">
              <span className="skeleton" style={{ height: 10, width: 80, display: "inline-block", borderRadius: 2 }} />
            </div>
            <div className="skeleton" style={{ height: 30, width: 90, borderRadius: 4, marginTop: 4 }} />
            <div className="shimmer-line" style={{ marginTop: 14 }} />
          </div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div className="tech-card" style={{ height: 240 }}>
          <div className="tech-header"><div className="tech-title">Score distribution</div></div>
          <div className="shimmer-line" style={{ marginTop: 30 }} />
        </div>
        <div className="tech-card" style={{ height: 240 }}>
          <div className="tech-header"><div className="tech-title">Label distribution</div></div>
          <div className="shimmer-line" style={{ marginTop: 30 }} />
        </div>
      </div>
    </div>
  );
}

function LeadQualityError({ err }: { err: string }) {
  return (
    <div className="empty-state">
      <div className="empty-icon"><AlertTriangle style={{ width: 22, height: 22 }} /></div>
      <h3>Scorer failed to load</h3>
      <p>{err}</p>
    </div>
  );
}

function LeadQualityMissing() {
  return (
    <div className="empty-state">
      <div className="empty-icon"><Star style={{ width: 22, height: 22 }} /></div>
      <h3>No trained scorer found</h3>
      <p>
        Run <code style={{ background: "var(--bg)", padding: "2px 6px", borderRadius: 4, border: "1px solid var(--border-light)", fontFamily: "ui-monospace, monospace", fontSize: 11.5 }}>python train_scorer.py</code> to train the model.
      </p>
    </div>
  );
}

function ScorerTabBtn({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        padding: "8px 14px", fontSize: 13,
        fontWeight: active ? 600 : 400,
        background: "transparent",
        border: "none",
        borderBottom: "2px solid " + (active ? "var(--fg, var(--text))" : "transparent"),
        color: active ? "var(--text)" : "var(--text-tertiary)",
        cursor: "pointer",
        marginBottom: -1,
      }}
    >
      {icon}
      {label}
    </button>
  );
}

function LeadQualityView({
  meta, history, live, labelData,
}: {
  meta: ScorerMeta;
  history: HistoryEntry[];
  live: LiveData | null;
  labelData: { name: string; count: number }[];
}) {
  return (
    <div>

      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr 1fr 1.2fr", gap: 12, marginBottom: 20 }}>
        <TechMetric label="F1 Score"  value={meta.cv_f1_mean.toFixed(3)} sub={`σ ± ${meta.cv_f1_std.toFixed(3)}`} accent />
        <TechMetric label="AUC"       value={meta.cv_auc.toFixed(3)} accent />
        <TechMetric label="Precision" value={meta.cv_precision.toFixed(3)} />
        <TechMetric label="Recall"    value={meta.cv_recall.toFixed(3)} />
        <TechMetric label="Samples"   value={meta.n_samples.toLocaleString()} sub={`${meta.n_positive} pos · ${meta.n_negative} neg`} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 24 }}>
        {meta.score_distribution && meta.score_distribution.length > 0 && (
          <div className="section-card">
            <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <BarChart3 className="h-4 w-4" />
              Score Distribution
            </h3>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={meta.score_distribution}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" />
                <XAxis dataKey="bin" tick={{ fill: "var(--text-tertiary)", fontSize: 9 }} interval={3} />
                <YAxis tick={{ fill: "var(--text-tertiary)", fontSize: 10 }} />
                <Tooltip contentStyle={TOOLTIP} />
                <Bar dataKey="count" fill="#3B82F6" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        <div className="section-card">
          <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <BarChart3 className="h-4 w-4" />
            Label Sources
          </h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={labelData} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" />
              <XAxis type="number" tick={{ fill: "var(--text-tertiary)", fontSize: 10 }} />
              <YAxis type="category" dataKey="name" tick={{ fill: "var(--text-secondary)", fontSize: 11 }} width={100} />
              <Tooltip contentStyle={TOOLTIP} />
              <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                {labelData.map((entry, i) => (
                  <Cell
                    key={i}
                    fill={
                      entry.name.includes("wechat") ? "#16A34A"
                      : entry.name.includes("clicked") ? "#3B82F6"
                      : entry.name.includes("pos") ? "#B45309"
                      : "var(--text-tertiary)"
                    }
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {history.length > 1 && (
        <div className="section-card" style={{ marginBottom: 24 }}>
          <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <TrendingUp className="h-4 w-4" />
            Training History
          </h3>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={history.map((h) => ({
              ...h,
              date: new Date(h.trained_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
            }))}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" />
              <XAxis dataKey="date" tick={{ fill: "var(--text-tertiary)", fontSize: 10 }} />
              <YAxis domain={[0.5, 1]} tick={{ fill: "var(--text-tertiary)", fontSize: 10 }} />
              <Tooltip contentStyle={TOOLTIP} />
              <Line type="monotone" dataKey="cv_f1"        stroke="#3B82F6" name="F1"        strokeWidth={2} dot={{ r: 4 }} />
              <Line type="monotone" dataKey="cv_auc"       stroke="#16A34A" name="AUC"       strokeWidth={2} dot={{ r: 4 }} />
              <Line type="monotone" dataKey="cv_precision" stroke="#B45309" name="Precision" strokeWidth={1} strokeDasharray="5 5" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {meta.gemini_vs_scorer && (
        <div className="section-card">
          <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <GitCompare className="h-4 w-4" />
            Gemini vs Scorer
          </h3>
          <div style={{ display: "flex", gap: 24, fontSize: 12, color: "var(--text-secondary)", marginBottom: 16 }}>
            <span>Correlation: <strong style={{ color: "#1A1A1A" }}>{meta.gemini_vs_scorer.correlation.toFixed(3)}</strong></span>
            <span>Mean Gemini: <strong style={{ color: "#B45309" }}>{meta.gemini_vs_scorer.mean_gemini.toFixed(3)}</strong></span>
            <span>Mean Scorer: <strong style={{ color: "#2563EB" }}>{meta.gemini_vs_scorer.mean_scorer.toFixed(3)}</strong></span>
          </div>

          {meta.gemini_vs_scorer.disagreements.length > 0 && (
            <div>
              <p style={{ fontSize: 11, color: "var(--text-tertiary)", fontWeight: 500, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
                <AlertTriangle className="h-3 w-3" />
                Biggest Disagreements
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 300, overflowY: "auto" }}>
                {meta.gemini_vs_scorer.disagreements.map((d, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, background: "var(--bg)", border: "1px solid var(--border-light)", borderRadius: 6, padding: "8px 12px", fontSize: 11 }}>
                    <span style={{ color: "var(--text-secondary)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {d.title}
                    </span>
                    <span style={{ color: "#B45309", flexShrink: 0, width: 56, textAlign: "right" }}>G: {d.gemini}</span>
                    <span style={{ color: "#2563EB", flexShrink: 0, width: 56, textAlign: "right" }}>S: {d.scorer}</span>
                    <span style={{ color: d.diff > 0.4 ? "#DC2626" : "#B45309", flexShrink: 0, width: 40, textAlign: "right", fontWeight: 600 }}>
                      {d.diff > 0 ? "+" : ""}{d.diff}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ════════════════════ LIVE SECTION ════════════════════
          Production-data analytics — what the scorer is doing right
          now, not training-set retrospective metrics. */}
      {live && live.scoredLeads > 0 && (
        <>
          <div style={{ marginTop: 32, marginBottom: 18, paddingTop: 24, borderTop: "1px solid var(--border)" }}>
            <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Live in production</h2>
            <p style={{ fontSize: 12, color: "var(--text-tertiary)", margin: 0 }}>
              {live.scoredLeads.toLocaleString()} of {live.totalLeads.toLocaleString()} leads have a score · mean {live.meanScore.toFixed(2)}
            </p>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 24 }}>
            <MetricCard label="Scored leads"    value={live.scoredLeads.toLocaleString()} sub={`of ${live.totalLeads}`} />
            <MetricCard label="Mean score"      value={live.meanScore.toFixed(2)} />
            <MetricCard
              label="Source coverage"
              value={`${live.sourceBreakdown.pythonScored + live.sourceBreakdown.apiScored}`}
              sub={`Py: ${live.sourceBreakdown.pythonScored} · API: ${live.sourceBreakdown.apiScored} · none: ${live.sourceBreakdown.unscored}`}
            />
          </div>

          {/* Calibration — does the score predict outcomes? */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 24 }}>
            <div className="section-card">
              <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <BarChart3 className="h-4 w-4" />
                Live distribution
              </h3>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={live.distribution}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" />
                  <XAxis dataKey="bin" tick={{ fill: "var(--text-tertiary)", fontSize: 10 }} />
                  <YAxis tick={{ fill: "var(--text-tertiary)", fontSize: 10 }} />
                  <Tooltip contentStyle={TOOLTIP} />
                  <Bar dataKey="count" fill="#3B82F6" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="section-card">
              <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <TrendingUp className="h-4 w-4" />
                Calibration: score → conversion
                <span className="lead-count" style={{ marginLeft: 8 }}>does it predict?</span>
              </h3>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={live.calibration.filter((c) => c.sent > 0)}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" />
                  <XAxis dataKey="bin" tick={{ fill: "var(--text-tertiary)", fontSize: 10 }} />
                  <YAxis tick={{ fill: "var(--text-tertiary)", fontSize: 10 }} unit="%" />
                  <Tooltip contentStyle={TOOLTIP} formatter={(v) => [`${v}%`, "Conv rate"]} />
                  <Bar dataKey="convRate" fill="#16A34A" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Top pending — sales action queue */}
          {live.topPending.length > 0 && (
            <div className="section-card" style={{ marginBottom: 24 }}>
              <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Star className="h-4 w-4" />
                Top scored & ready
                <span className="lead-count" style={{ marginLeft: 8 }}>send these first</span>
              </h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {live.topPending.map((p) => (
                  <a
                    key={p.id}
                    href={`/pipeline#lead-${p.id}`}
                    style={{ display: "flex", alignItems: "center", gap: 12, background: "var(--bg)", border: "1px solid var(--border-light)", borderRadius: 6, padding: "8px 12px", fontSize: 12, textDecoration: "none", color: "inherit" }}
                  >
                    <span style={{ color: "#16A34A", fontWeight: 600, flexShrink: 0, width: 50 }}>★ {(p.score * 100).toFixed(0)}</span>
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title}</span>
                    {p.tier === "strong" && <span style={{ color: "#B45309", flexShrink: 0, fontSize: 10, fontWeight: 600 }}>STRONG</span>}
                    {p.citations !== null && p.citations > 0 && <span style={{ color: "var(--text-tertiary)", flexShrink: 0 }}>{p.citations.toLocaleString()} cites</span>}
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* Misses + Hidden Wins — training signal for next iteration */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 24 }}>
            {live.bigMisses.length > 0 && (
              <div className="section-card">
                <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <AlertTriangle className="h-4 w-4" style={{ color: "#DC2626" }} />
                  Big misses
                  <span className="lead-count" style={{ marginLeft: 6 }}>high score, no convert</span>
                </h3>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {live.bigMisses.map((m) => (
                    <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11.5, color: "var(--text-secondary)" }}>
                      <span style={{ color: "#DC2626", fontWeight: 600, flexShrink: 0, width: 42 }}>★ {(m.score * 100).toFixed(0)}</span>
                      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.title}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {live.hiddenWins.length > 0 && (
              <div className="section-card">
                <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Star className="h-4 w-4" style={{ color: "#16A34A" }} />
                  Hidden wins
                  <span className="lead-count" style={{ marginLeft: 6 }}>low score, converted</span>
                </h3>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {live.hiddenWins.map((w) => (
                    <div key={w.id} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11.5, color: "var(--text-secondary)" }}>
                      <span style={{ color: "var(--text-tertiary)", fontWeight: 600, flexShrink: 0, width: 42 }}>★ {(w.score * 100).toFixed(0)}</span>
                      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{w.title}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Per-category quality */}
          {live.byCategory.length > 0 && (
            <div className="section-card" style={{ marginBottom: 24 }}>
              <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <BarChart3 className="h-4 w-4" />
                Score by category
                <span className="lead-count" style={{ marginLeft: 8 }}>where the scorer is confident</span>
              </h3>
              <table className="data-table" style={{ marginTop: 8 }}>
                <thead>
                  <tr>
                    <th>Category</th><th>Leads</th><th>Mean score</th><th>Sent</th><th>WeChat</th><th>Conv %</th>
                  </tr>
                </thead>
                <tbody>
                  {live.byCategory.map((c) => (
                    <tr key={c.name}>
                      <td style={{ fontSize: 12, color: c.name === "(unmatched)" ? "var(--text-tertiary)" : "var(--text)" }}>{c.name}</td>
                      <td>{c.count}</td>
                      <td style={{ color: c.meanScore >= 0.7 ? "#16A34A" : c.meanScore >= 0.4 ? "#B45309" : "var(--text-tertiary)", fontWeight: 600 }}>
                        {c.meanScore.toFixed(2)}
                      </td>
                      <td>{c.sent}</td>
                      <td>{c.converted}</td>
                      <td style={{ color: c.convRate > 0 ? "var(--green)" : "var(--text-tertiary)", fontWeight: c.convRate > 0 ? 600 : 400 }}>
                        {c.convRate}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <CitationBackfillCard />
      <LeadTrainWorkbench />
    </div>
  );
}

