// /scorer/calibration — second scorer line in standard app vocabulary.
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Play } from "lucide-react";

interface ModelScore {
  model: string;
  n: number;
  click_accuracy: number;
  wechat_accuracy: number;
  click_brier: number;
  wechat_brier: number;
  click_log_loss: number;
  wechat_log_loss: number;
  avg_latency_s: number;
  errors: number;
  cards: Array<{ lead_id: string; pred: { p_click: number; p_wechat: number; rationale: string }; actual: { click: boolean; wechat: boolean } }>;
}

interface Payload {
  sample_size: number;
  models: ModelScore[];
  generated_at?: string;
  note?: string;
}

interface HistoryRun {
  id: string;
  model: string;
  click_brier: number;
  wechat_brier: number;
  click_accuracy: number;
  wechat_accuracy: number;
  run_at: string;
}

interface HistoryPayload {
  models: Array<{ model: string; runs: HistoryRun[] }>;
  total_runs: number;
}

const DEFAULT_MODELS = "claude-sonnet-4.6,gemini-2.5-flash,gpt-5-mini,glm-4.7";

export default function ScorerCalibrationPage() {
  const router = useRouter();
  const [data, setData] = useState<Payload | null>(null);
  const [history, setHistory] = useState<HistoryPayload | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [models, setModels] = useState(DEFAULT_MODELS);

  const loadHistory = () => {
    fetch("/api/scorer/model-calibration/history?days=90")
      .then(async (r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setHistory(d); })
      .catch(() => { /* swallow — history is optional */ });
  };

  useEffect(() => {
    fetch("/api/auth/me").then((r) => {
      if (r.status === 401) router.replace("/login?next=/scorer/calibration");
    });
    loadHistory();
  }, [router]);

  const run = () => {
    setRunning(true);
    setErr(null);
    fetch(`/api/scorer/model-calibration?models=${encodeURIComponent(models)}`)
      .then(async (r) => {
        if (r.status === 401) { router.replace("/login?next=/scorer/calibration"); return null; }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => { if (d) setData(d); loadHistory(); })
      .catch((e) => setErr(String(e)))
      .finally(() => setRunning(false));
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <div style={{
            fontSize: 11,
            fontWeight: 600,
            color: "var(--text-tertiary)",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            marginBottom: 4,
          }}>
            Scorer · Model calibration
          </div>
          <h1 className="page-title">Which model predicts this market best?</h1>
          <p style={{ fontSize: 13, color: "var(--text-tertiary)", marginTop: 4, maxWidth: 640, lineHeight: 1.55 }}>
            For every candidate model, we ask it to predict <code style={{ fontFamily: "ui-monospace, monospace" }}>p(click)</code> and <code style={{ fontFamily: "ui-monospace, monospace" }}>p(wechat)</code> on a sample of recently-sent leads where we already know the actual outcomes. Lower Brier + log-loss means better-calibrated probabilities.
          </p>
        </div>
      </div>

      {/* Controls */}
      <div className="section-card" style={{ padding: 16, marginBottom: 20 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>
          Models to test
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <input
            type="text"
            value={models}
            onChange={(e) => setModels(e.target.value)}
            spellCheck={false}
            style={{
              flex: 1,
              minWidth: 280,
              padding: "8px 10px",
              fontFamily: "ui-monospace, monospace",
              fontSize: 12.5,
              background: "var(--bg)",
              color: "var(--text)",
              border: "1px solid var(--border)",
              borderRadius: 6,
            }}
            placeholder="comma-separated model ids"
          />
          <button
            type="button"
            onClick={run}
            disabled={running}
            className="btn btn-primary"
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            {running ? "Running…" : "Run calibration"}
          </button>
        </div>
      </div>

      {err && (
        <div style={{
          padding: "10px 14px",
          borderRadius: 8,
          border: "1px solid var(--coral)",
          background: "rgba(239, 68, 68, 0.08)",
          color: "var(--coral)",
          fontSize: 13,
          marginBottom: 18,
        }}>
          {err}
        </div>
      )}

      {!data && !running && (
        <div className="section-card" style={{ padding: "20px 16px", textAlign: "center", fontSize: 13, color: "var(--text-tertiary)" }}>
          Press <strong>Run calibration</strong> to score the models against the last 60 days of real outcomes.
        </div>
      )}

      {data && <ResultsTable data={data} />}

      {history && history.total_runs > 1 && <DriftSection history={history} />}
    </div>
  );
}

function DriftSection({ history }: { history: HistoryPayload }) {
  // Show one row per model; each row has a sparkline of click_brier over time.
  // Lower is better, so we invert the y-axis interpretation visually.
  return (
    <section style={{ marginTop: 32 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Drift over time</h3>
        <span className="lead-count">{history.total_runs} runs</span>
      </div>
      <div className="section-card" style={{ padding: 0, overflow: "hidden" }}>
        <table className="data-table" style={{ marginBottom: 0 }}>
          <thead>
            <tr>
              <th>Model</th>
              <th style={{ textAlign: "left" }}>Click Brier (lower = better)</th>
              <th style={{ textAlign: "right" }}>Latest</th>
              <th style={{ textAlign: "right" }}>Δ vs first</th>
              <th style={{ textAlign: "right" }}>Runs</th>
            </tr>
          </thead>
          <tbody>
            {history.models.map((m) => <DriftRow key={m.model} model={m.model} runs={m.runs} />)}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DriftRow({ model, runs }: { model: string; runs: HistoryRun[] }) {
  if (runs.length === 0) return null;
  const series = runs.map((r) => r.click_brier);
  const latest = series[series.length - 1];
  const first = series[0];
  const delta = latest - first;
  const deltaColor = delta < -0.01 ? "var(--green)" : delta > 0.01 ? "var(--coral)" : "var(--text-tertiary)";
  return (
    <tr>
      <td style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>{model}</td>
      <td><Sparkline values={series} /></td>
      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
        {latest.toFixed(3)}
      </td>
      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: deltaColor, fontWeight: 600 }}>
        {delta > 0 ? "+" : ""}{delta.toFixed(3)}
      </td>
      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--text-tertiary)" }}>
        {runs.length}
      </td>
    </tr>
  );
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) {
    return <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>—</span>;
  }
  const w = 160, h = 28, pad = 3;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(1e-6, max - min);
  // For Brier, lower is better — we render lower values higher on screen
  // (i.e. invert y) so an improving model trends UP visually.
  const xs = values.map((_, i) => pad + (i / Math.max(1, values.length - 1)) * (w - 2 * pad));
  const ys = values.map((v) => pad + ((v - min) / range) * (h - 2 * pad));
  const path = values.map((_, i) => `${i === 0 ? "M" : "L"}${xs[i].toFixed(1)} ${ys[i].toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h} style={{ display: "block" }}>
      <path d={path} fill="none" stroke="var(--blue)" strokeWidth={1.5} />
      {values.map((_, i) => (
        <circle key={i} cx={xs[i]} cy={ys[i]} r={i === values.length - 1 ? 2.4 : 1.6}
          fill={i === values.length - 1 ? "var(--blue)" : "var(--text-tertiary)"} />
      ))}
    </svg>
  );
}

function ResultsTable({ data }: { data: Payload }) {
  if (data.sample_size === 0) {
    return (
      <div className="section-card" style={{ padding: "20px 16px", textAlign: "center", fontSize: 13, color: "var(--text-tertiary)" }}>
        {data.note ?? "No leads with outcomes in window."}
      </div>
    );
  }

  // Sort by combined Brier (lower is better).
  const ranked = [...data.models].sort((a, b) => (a.click_brier + a.wechat_brier) - (b.click_brier + b.wechat_brier));

  return (
    <div className="section-card" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{
        padding: "10px 16px",
        fontSize: 12,
        color: "var(--text-tertiary)",
        borderBottom: "1px solid var(--border-light)",
      }}>
        n = {data.sample_size} leads · lower Brier + log-loss is better
      </div>
      <table className="data-table" style={{ marginBottom: 0 }}>
        <thead>
          <tr>
            <th>Model</th>
            <th style={{ textAlign: "right" }}>Click acc.</th>
            <th style={{ textAlign: "right" }}>WeChat acc.</th>
            <th style={{ textAlign: "right" }}>Click Brier</th>
            <th style={{ textAlign: "right" }}>WeChat Brier</th>
            <th style={{ textAlign: "right" }}>Latency</th>
            <th style={{ textAlign: "right" }}>Errs</th>
          </tr>
        </thead>
        <tbody>
          {ranked.map((m, i) => (
            <ModelRow key={m.model} m={m} rank={i + 1} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ModelRow({ m, rank }: { m: ModelScore; rank: number }) {
  const accColor = (v: number) => v >= 0.7 ? "var(--green)" : v >= 0.5 ? "var(--gold)" : "var(--coral)";
  const brierColor = (v: number) => v <= 0.15 ? "var(--green)" : v <= 0.25 ? "var(--gold)" : "var(--coral)";
  return (
    <tr>
      <td style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
        <span style={{ color: "var(--text-tertiary)", marginRight: 8 }}>{rank}.</span>
        <strong>{m.model}</strong>
      </td>
      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: accColor(m.click_accuracy), fontWeight: 600 }}>
        {(m.click_accuracy * 100).toFixed(1)}%
      </td>
      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: accColor(m.wechat_accuracy), fontWeight: 600 }}>
        {(m.wechat_accuracy * 100).toFixed(1)}%
      </td>
      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: brierColor(m.click_brier), fontWeight: 600 }}>
        {m.click_brier.toFixed(3)}
      </td>
      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: brierColor(m.wechat_brier), fontWeight: 600 }}>
        {m.wechat_brier.toFixed(3)}
      </td>
      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--text-secondary)" }}>
        {m.avg_latency_s.toFixed(2)}s
      </td>
      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: m.errors > 0 ? "var(--coral)" : "var(--text-tertiary)" }}>
        {m.errors}
      </td>
    </tr>
  );
}
