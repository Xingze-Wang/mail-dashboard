"use client";

import { useEffect, useState } from "react";
import { Brain, TrendingUp, BarChart3, GitCompare, AlertTriangle } from "lucide-react";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ScatterChart,
  Scatter,
  Cell,
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
    disagreements: {
      title: string;
      gemini: number;
      scorer: number;
      diff: number;
      label: number;
    }[];
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

function MetricCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-4">
      <p className="text-[11px] text-neutral-500 mb-1">{label}</p>
      <p className="text-2xl font-semibold text-white">{value}</p>
      {sub && <p className="text-[11px] text-neutral-600 mt-1">{sub}</p>}
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
        if (data.error) {
          setError(data.error);
        } else {
          setMeta(data.metadata);
          setHistory(data.history || []);
        }
      })
      .catch(() => setError("Failed to load scorer data"))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="p-8">
        <p className="text-neutral-500 animate-pulse">Loading scorer data...</p>
      </div>
    );
  }

  if (error || !meta) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-semibold text-white mb-4 flex items-center gap-2">
          <Brain className="h-6 w-6" />
          Scorer
        </h1>
        <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-8 text-center">
          <Brain className="h-10 w-10 text-neutral-700 mx-auto mb-3" />
          <p className="text-[14px] text-neutral-400 mb-2">No scorer model found</p>
          <p className="text-[12px] text-neutral-600">
            Run <code className="bg-neutral-800 px-1.5 py-0.5 rounded">python train_scorer.py</code> to train the model
          </p>
        </div>
      </div>
    );
  }

  const trainedDate = new Date(meta.trained_at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const labelData = Object.entries(meta.label_distribution)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => ({
      name: k.replace(/_/g, " ").replace(/\d\.\d/, ""),
      count: v,
    }));

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-white tracking-tight flex items-center gap-2">
            <Brain className="h-6 w-6" />
            Scorer
          </h1>
          <p className="text-sm text-neutral-400 mt-1">
            {meta.embedder} &middot; Trained {trainedDate}
          </p>
        </div>
      </div>

      {/* Metrics row */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-6">
        <MetricCard
          label="F1 Score"
          value={meta.cv_f1_mean.toFixed(3)}
          sub={`+/- ${meta.cv_f1_std.toFixed(3)}`}
        />
        <MetricCard label="AUC" value={meta.cv_auc.toFixed(3)} />
        <MetricCard label="Precision" value={meta.cv_precision.toFixed(3)} />
        <MetricCard label="Recall" value={meta.cv_recall.toFixed(3)} />
        <MetricCard
          label="Samples"
          value={meta.n_samples.toLocaleString()}
          sub={`${meta.n_positive} pos / ${meta.n_negative} neg`}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        {/* Score distribution */}
        {meta.score_distribution && meta.score_distribution.length > 0 && (
          <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-5">
            <h3 className="text-[13px] font-semibold text-neutral-300 mb-4 flex items-center gap-2">
              <BarChart3 className="h-4 w-4" />
              Score Distribution
            </h3>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={meta.score_distribution}>
                <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                <XAxis
                  dataKey="bin"
                  tick={{ fill: "#666", fontSize: 9 }}
                  interval={3}
                />
                <YAxis tick={{ fill: "#666", fontSize: 10 }} />
                <Tooltip
                  contentStyle={{
                    background: "#1a1a1a",
                    border: "1px solid #333",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                />
                <Bar dataKey="count" fill="#3b82f6" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Label distribution */}
        <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-5">
          <h3 className="text-[13px] font-semibold text-neutral-300 mb-4 flex items-center gap-2">
            <BarChart3 className="h-4 w-4" />
            Label Sources
          </h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={labelData} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="#333" />
              <XAxis type="number" tick={{ fill: "#666", fontSize: 10 }} />
              <YAxis
                type="category"
                dataKey="name"
                tick={{ fill: "#999", fontSize: 11 }}
                width={100}
              />
              <Tooltip
                contentStyle={{
                  background: "#1a1a1a",
                  border: "1px solid #333",
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
              <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                {labelData.map((entry, i) => (
                  <Cell
                    key={i}
                    fill={
                      entry.name.includes("wechat")
                        ? "#22c55e"
                        : entry.name.includes("clicked")
                          ? "#3b82f6"
                          : entry.name.includes("pos")
                            ? "#eab308"
                            : "#666"
                    }
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Training history */}
      {history.length > 1 && (
        <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-5 mb-6">
          <h3 className="text-[13px] font-semibold text-neutral-300 mb-4 flex items-center gap-2">
            <TrendingUp className="h-4 w-4" />
            Training History
          </h3>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart
              data={history.map((h) => ({
                ...h,
                date: new Date(h.trained_at).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                }),
              }))}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#333" />
              <XAxis dataKey="date" tick={{ fill: "#666", fontSize: 10 }} />
              <YAxis
                domain={[0.5, 1]}
                tick={{ fill: "#666", fontSize: 10 }}
              />
              <Tooltip
                contentStyle={{
                  background: "#1a1a1a",
                  border: "1px solid #333",
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
              <Line
                type="monotone"
                dataKey="cv_f1"
                stroke="#3b82f6"
                name="F1"
                strokeWidth={2}
                dot={{ r: 4 }}
              />
              <Line
                type="monotone"
                dataKey="cv_auc"
                stroke="#22c55e"
                name="AUC"
                strokeWidth={2}
                dot={{ r: 4 }}
              />
              <Line
                type="monotone"
                dataKey="cv_precision"
                stroke="#eab308"
                name="Precision"
                strokeWidth={1}
                strokeDasharray="5 5"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Gemini vs Scorer */}
      {meta.gemini_vs_scorer && (
        <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-5 mb-6">
          <h3 className="text-[13px] font-semibold text-neutral-300 mb-3 flex items-center gap-2">
            <GitCompare className="h-4 w-4" />
            Gemini vs Scorer
          </h3>
          <div className="flex items-center gap-6 text-[12px] text-neutral-500 mb-4">
            <span>
              Correlation:{" "}
              <span className="text-white font-medium">
                {meta.gemini_vs_scorer.correlation.toFixed(3)}
              </span>
            </span>
            <span>
              Mean Gemini:{" "}
              <span className="text-yellow-400">
                {meta.gemini_vs_scorer.mean_gemini.toFixed(3)}
              </span>
            </span>
            <span>
              Mean Scorer:{" "}
              <span className="text-blue-400">
                {meta.gemini_vs_scorer.mean_scorer.toFixed(3)}
              </span>
            </span>
          </div>

          {/* Top disagreements */}
          {meta.gemini_vs_scorer.disagreements.length > 0 && (
            <div>
              <p className="text-[11px] text-neutral-500 font-medium mb-2 flex items-center gap-1.5">
                <AlertTriangle className="h-3 w-3" />
                Biggest Disagreements
              </p>
              <div className="space-y-1.5 max-h-[300px] overflow-y-auto">
                {meta.gemini_vs_scorer.disagreements.map((d, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-3 rounded-md bg-neutral-800/50 px-3 py-2 text-[11px]"
                  >
                    <span className="text-neutral-400 truncate flex-1 min-w-0">
                      {d.title}
                    </span>
                    <span className="text-yellow-400 shrink-0 w-14 text-right">
                      G: {d.gemini}
                    </span>
                    <span className="text-blue-400 shrink-0 w-14 text-right">
                      S: {d.scorer}
                    </span>
                    <span
                      className={`shrink-0 w-10 text-right font-medium ${
                        d.diff > 0.4 ? "text-red-400" : "text-amber-400"
                      }`}
                    >
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
