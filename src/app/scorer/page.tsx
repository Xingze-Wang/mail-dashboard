"use client";

import { useEffect, useState } from "react";
import { Brain, TrendingUp, BarChart3, GitCompare, AlertTriangle } from "lucide-react";
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

export default function ScorerPage() {
  const [meta, setMeta] = useState<ScorerMeta | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/scorer")
      .then((r) => r.json())
      .then((data) => {
        if (data.error) setError(data.error);
        else {
          setMeta(data.metadata);
          setHistory(data.history || []);
        }
      })
      .catch(() => setError("Failed to load scorer data"))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28 }}>
          <h1 className="page-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Brain className="h-6 w-6" />
            Scorer
          </h1>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr 1fr 1.2fr", gap: 16, marginBottom: 24 }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="skeleton" style={{ height: 100 }} />
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div className="skeleton" style={{ height: 240 }} />
          <div className="skeleton" style={{ height: 240 }} />
        </div>
      </div>
    );
  }

  if (error || !meta) {
    return (
      <div>
        <h1 className="page-title" style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
          <Brain className="h-6 w-6" />
          Scorer
        </h1>
        <div className="empty-state">
          <div className="empty-icon">
            <Brain style={{ width: 22, height: 22 }} />
          </div>
          <h3>No scorer model found</h3>
          <p>
            Run <code style={{ background: "var(--bg)", padding: "2px 6px", borderRadius: 4, border: "1px solid var(--border-light)", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11.5 }}>python train_scorer.py</code> to train the model.
          </p>
        </div>
      </div>
    );
  }

  const trainedDate = new Date(meta.trained_at).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit",
  });

  const labelData = Object.entries(meta.label_distribution)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => ({ name: k.replace(/_/g, " ").replace(/\d\.\d/, ""), count: v }));

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 28 }}>
        <div>
          <h1 className="page-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Brain className="h-6 w-6" />
            Scorer
          </h1>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 6 }}>
            {meta.embedder} · Trained {trainedDate}
          </p>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1.2fr 1fr 1fr 1.2fr", gap: 16, marginBottom: 24 }}>
        <MetricCard label="F1 Score"  value={meta.cv_f1_mean.toFixed(3)} sub={`± ${meta.cv_f1_std.toFixed(3)}`} emphasis />
        <MetricCard label="AUC"       value={meta.cv_auc.toFixed(3)} emphasis />
        <MetricCard label="Precision" value={meta.cv_precision.toFixed(3)} />
        <MetricCard label="Recall"    value={meta.cv_recall.toFixed(3)} />
        <MetricCard label="Samples"   value={meta.n_samples.toLocaleString()} sub={`${meta.n_positive} pos · ${meta.n_negative} neg`} />
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
    </div>
  );
}
