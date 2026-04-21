"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Play, Zap, BarChart3, ChevronDown, ChevronRight } from "lucide-react";

interface ModelAgg {
  model: string;
  analyzeAvg: number;
  introAvg: number;
  latencyAvg: number;
  tokensInAvg: number;
  tokensOutAvg: number;
  jsonValidPct: number | null;
  errors: number;
}

interface Run {
  runId: string;
  createdAt: string;
  models: ModelAgg[];
}

interface BenchData {
  models: string[];
  runs: Run[];
}

interface RunDetail {
  runId: string;
  rows: Array<{
    model: string;
    task: "analyze" | "intro";
    sample_idx: number;
    score: number;
    latency_s: number;
    tokens_in: number | null;
    tokens_out: number | null;
    output_text: string;
    error: string | null;
  }>;
}

export default function BenchPage() {
  const router = useRouter();
  const [gated, setGated] = useState<"checking" | "allowed" | "forbidden">("checking");
  const [data, setData] = useState<BenchData | null>(null);
  const [running, setRunning] = useState(false);
  const [pickedModels, setPicked] = useState<Set<string>>(new Set());
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [openRunDetail, setOpenRunDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/auth/me").then((r) => r.json()).then((d) => {
      if (d.authenticated && d.role === "admin") setGated("allowed");
      else { setGated("forbidden"); router.replace("/"); }
    }).catch(() => { setGated("forbidden"); router.replace("/"); });
  }, [router]);

  const refresh = () => {
    fetch("/api/bench").then((r) => r.json()).then((d: BenchData) => {
      setData(d);
      if (pickedModels.size === 0 && d.models?.length) {
        // Pre-select cheap+fast Chinese models by default
        setPicked(new Set(["glm-4.7", "deepseek-v3", "qwen3-235b", "gemini-3-flash"]));
      }
    }).catch((e) => setError(String(e)));
  };

  useEffect(() => { if (gated === "allowed") refresh(); /* eslint-disable-next-line */ }, [gated]);

  const togglePick = (m: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(m)) next.delete(m); else next.add(m);
      return next;
    });
  };

  const runBench = async () => {
    if (pickedModels.size === 0) return;
    setRunning(true);
    setError(null);
    try {
      const r = await fetch("/api/bench", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models: Array.from(pickedModels) }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        setError(e.error || `HTTP ${r.status}`);
      } else {
        refresh();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  const expandRun = async (runId: string) => {
    if (openRun === runId) {
      setOpenRun(null);
      setOpenRunDetail(null);
      return;
    }
    setOpenRun(runId);
    setOpenRunDetail(null);
    const d = await fetch(`/api/bench/${runId}`).then((r) => r.json());
    setOpenRunDetail(d);
  };

  if (gated !== "allowed") {
    return <div style={{ display: "flex", justifyContent: "center", padding: 96 }}><Loader2 className="h-6 w-6 animate-spin" /></div>;
  }

  const latest = data?.runs?.[0];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 28 }}>
        <div>
          <h1 className="page-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Zap className="h-6 w-6" />
            Model Bench
          </h1>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 6 }}>
            Run any of the {data?.models?.length ?? 0} models on the actual tasks resend0412.py uses (paper-judgment + Chinese intro).
            Each run = {pickedModels.size || "?"} models × 3 papers × 2 tasks = {(pickedModels.size || 0) * 6} calls.
          </p>
        </div>
      </div>

      {/* Model selector */}
      <div className="section-card" style={{ marginBottom: 24 }}>
        <h3 style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <BarChart3 className="h-4 w-4" />
          Pick models to bench
        </h3>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {(data?.models ?? []).map((m) => (
            <button
              key={m}
              onClick={() => togglePick(m)}
              className={`dx-chip ${pickedModels.has(m) ? "active" : ""}`}
              style={{ fontSize: 12 }}
              type="button"
            >
              {m}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 16 }}>
          <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
            {pickedModels.size} selected · ~{Math.round(pickedModels.size * 6 * 5)}s estimate
          </span>
          <button
            type="button"
            onClick={runBench}
            disabled={running || pickedModels.size === 0}
            className="dx-primary"
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {running ? "Running…" : "Run benchmark"}
          </button>
        </div>
        {error && <div style={{ marginTop: 12, fontSize: 12, color: "#DC2626" }}>{error}</div>}
      </div>

      {/* Latest run leaderboard */}
      {latest && (
        <div className="section-card" style={{ marginBottom: 24 }}>
          <h3 style={{ marginBottom: 12 }}>
            Latest run
            <span className="lead-count" style={{ marginLeft: 8 }}>
              {new Date(latest.createdAt).toLocaleString()}
            </span>
          </h3>
          <table className="data-table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Analyze</th>
                <th>Intro</th>
                <th>Combined</th>
                <th>Latency (avg/call)</th>
                <th>Tokens out</th>
                <th>JSON ✓</th>
                <th>Errors</th>
              </tr>
            </thead>
            <tbody>
              {latest.models.map((m) => {
                const combined = Math.round((m.analyzeAvg + m.introAvg) * 50) / 100;
                return (
                  <tr key={m.model}>
                    <td style={{ fontWeight: 600 }}>{m.model}</td>
                    <td style={{ color: m.analyzeAvg >= 0.85 ? "var(--green)" : m.analyzeAvg >= 0.5 ? "var(--gold)" : "var(--coral)", fontWeight: 600 }}>
                      {m.analyzeAvg.toFixed(2)}
                    </td>
                    <td style={{ color: m.introAvg >= 0.7 ? "var(--green)" : m.introAvg >= 0.4 ? "var(--gold)" : "var(--coral)", fontWeight: 600 }}>
                      {m.introAvg.toFixed(2)}
                    </td>
                    <td style={{ fontWeight: 700 }}>{combined.toFixed(2)}</td>
                    <td>{m.latencyAvg.toFixed(1)}s</td>
                    <td style={{ color: "var(--text-tertiary)" }}>{m.tokensOutAvg}</td>
                    <td style={{ color: m.jsonValidPct === 100 ? "var(--green)" : m.jsonValidPct === null ? "var(--text-tertiary)" : "var(--coral)" }}>
                      {m.jsonValidPct === null ? "—" : `${m.jsonValidPct}%`}
                    </td>
                    <td style={{ color: m.errors > 0 ? "var(--coral)" : "var(--text-tertiary)" }}>
                      {m.errors}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Historical runs */}
      {data && data.runs.length > 0 && (
        <div className="section-card">
          <h3 style={{ marginBottom: 12 }}>History ({data.runs.length} runs)</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {data.runs.map((r) => (
              <div key={r.runId} style={{ background: "var(--bg)", border: "1px solid var(--border-light)", borderRadius: 6, padding: 0, overflow: "hidden" }}>
                <button
                  type="button"
                  onClick={() => expandRun(r.runId)}
                  style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", background: "transparent", border: 0, cursor: "pointer", fontSize: 12, textAlign: "left" }}
                >
                  {openRun === r.runId ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  <span style={{ color: "var(--text-tertiary)" }}>{new Date(r.createdAt).toLocaleString()}</span>
                  <span style={{ color: "var(--text)", flex: 1 }}>
                    {r.models.length} models · best: <strong>{r.models[0]?.model}</strong> ({((r.models[0]?.analyzeAvg + r.models[0]?.introAvg) / 2).toFixed(2)})
                  </span>
                  <code style={{ color: "var(--text-tertiary)", fontSize: 11 }}>{r.runId}</code>
                </button>
                {openRun === r.runId && openRunDetail && (
                  <div style={{ borderTop: "1px solid var(--border-light)", padding: 12, background: "var(--card)", display: "flex", flexDirection: "column", gap: 8 }}>
                    {openRunDetail.rows.map((row, i) => (
                      <div key={i} style={{ display: "grid", gridTemplateColumns: "120px 70px 50px auto", gap: 12, fontSize: 11.5, alignItems: "start" }}>
                        <span style={{ fontWeight: 600 }}>{row.model}</span>
                        <span style={{ color: "var(--text-tertiary)" }}>{row.task} #{row.sample_idx + 1}</span>
                        <span style={{ color: row.score >= 0.7 ? "var(--green)" : row.score >= 0.4 ? "var(--gold)" : "var(--coral)", fontWeight: 600 }}>{row.score.toFixed(2)}</span>
                        <span style={{ color: row.error ? "var(--coral)" : "var(--text-secondary)", whiteSpace: "pre-wrap", overflow: "hidden", textOverflow: "ellipsis", maxHeight: 60, lineHeight: 1.4 }}>
                          {row.error ?? row.output_text.slice(0, 280)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
