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
        // Pre-select 1 from each tier — the headline horse race.
        setPicked(new Set([
          "claude-opus-4.7", "claude-sonnet-4.5",
          "gemini-3-pro", "gemini-3-flash",
          "gpt-5", "gpt-5-mini",
          "deepseek-v3", "qwen3-235b", "glm-4.7",
        ]));
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

      {/* Model selector — grouped by tier */}
      <div className="section-card" style={{ marginBottom: 24 }}>
        <h3 style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <BarChart3 className="h-4 w-4" />
          Pick models to bench
        </h3>
        {(() => {
          const groups: Record<string, string[]> = {
            "Frontier": [], "Fast / Cheap": [], "Chinese": [], "Other": [],
          };
          for (const m of data?.models ?? []) {
            if (/^(claude-(opus|sonnet)-(4|3)|gpt-5(\.|$)|gpt-4\.1$|gemini-(2\.5-pro|3-pro)|grok-4|^o[13]$)/.test(m)) groups["Frontier"].push(m);
            else if (/(mini|nano|flash|sonnet-4$|grok-3|o4-mini)/.test(m)) groups["Fast / Cheap"].push(m);
            else if (/^(glm|qwen|deepseek|kimi)/.test(m)) groups["Chinese"].push(m);
            else groups["Other"].push(m);
          }
          return Object.entries(groups).map(([gname, list]) => (
            list.length === 0 ? null : (
              <div key={gname} style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6 }}>
                  {gname}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {list.map((m) => (
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
              </div>
            )
          ));
        })()}
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
                  <RunDetail rows={openRunDetail.rows} />
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ───────────────────────── Run-detail viewer ─────────────────────────

const SAMPLE_TITLES = [
  "4D Gaussian Splatting (heavy compute, 3D Vision, Chinese author)",
  "FastInfer (heavy compute, LLM Architecture, Chinese author)",
  "Survey of Tokenization (no compute, NLP, non-Chinese author)",
];

function RunDetail({ rows }: { rows: RunDetail["rows"] }) {
  // Group rows: model → sample_idx → {analyze, intro}
  const byModel = new Map<string, Map<number, { analyze?: typeof rows[0]; intro?: typeof rows[0] }>>();
  for (const r of rows) {
    const mm = byModel.get(r.model) ?? new Map();
    const ss = mm.get(r.sample_idx) ?? {};
    if (r.task === "analyze") ss.analyze = r;
    if (r.task === "intro") ss.intro = r;
    mm.set(r.sample_idx, ss);
    byModel.set(r.model, mm);
  }

  // Active model selector (first model by default)
  const models = Array.from(byModel.keys());
  const [activeModel, setActiveModel] = useState<string>(models[0] ?? "");

  return (
    <div style={{ borderTop: "1px solid var(--border-light)", padding: 16, background: "var(--card)" }}>
      {/* Model tab strip */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
        {models.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setActiveModel(m)}
            className={`dx-chip ${activeModel === m ? "active" : ""}`}
            style={{ fontSize: 11 }}
          >
            {m}
          </button>
        ))}
      </div>

      {/* Per-sample rows for active model */}
      {activeModel && [0, 1, 2].map((sampleIdx) => {
        const pair = byModel.get(activeModel)?.get(sampleIdx);
        if (!pair) return null;
        return (
          <div key={sampleIdx} style={{ marginBottom: 18, padding: 12, background: "var(--bg)", borderRadius: 8, border: "1px solid var(--border-light)" }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 10 }}>
              Paper #{sampleIdx + 1}: {SAMPLE_TITLES[sampleIdx]}
            </div>

            {/* Analyze */}
            {pair.analyze && <TaskCard row={pair.analyze} task="analyze" />}
            {/* Intro */}
            {pair.intro && <TaskCard row={pair.intro} task="intro" />}
          </div>
        );
      })}
    </div>
  );
}

function TaskCard({ row, task }: { row: RunDetail["rows"][0]; task: "analyze" | "intro" }) {
  // output_text is JSON-encoded {raw, grade}
  let raw = "";
  let grade: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.output_text || "{}");
    raw = parsed.raw ?? "";
    grade = parsed.grade ?? {};
  } catch {
    raw = row.output_text || "";
  }

  const scoreColor = row.score >= 0.85 ? "var(--green)"
    : row.score >= 0.5 ? "var(--gold)" : "var(--coral)";

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6, fontSize: 11.5 }}>
        <span style={{ fontWeight: 600, textTransform: "uppercase", color: "var(--text-tertiary)", letterSpacing: "0.04em" }}>
          {task}
        </span>
        <span style={{ color: scoreColor, fontWeight: 700 }}>★ {row.score.toFixed(2)}</span>
        <span style={{ color: "var(--text-tertiary)" }}>{row.latency_s}s</span>
        <span style={{ color: "var(--text-tertiary)" }}>{row.tokens_out ?? "?"} tokens</span>
        {row.error && <span style={{ color: "var(--coral)" }}>ERROR</span>}
      </div>

      {/* Grade breakdown */}
      {!row.error && Object.keys(grade).length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8, fontSize: 10.5 }}>
          {task === "analyze" && (
            <>
              <Badge ok={grade.correctNeedsCompute as boolean | undefined} label="needs_compute" />
              <Badge ok={grade.correctLevel as boolean | undefined} label="level" />
              <Badge ok={grade.correctDirection as boolean | undefined} label="direction" />
              <Badge ok={grade.correctChinese as boolean | undefined} label="is_chinese" />
            </>
          )}
          {task === "intro" && (
            <>
              <Badge ok={grade.threePart as boolean | undefined} label="三段论" />
              <Badge ok={grade.noBannedSym as boolean | undefined} label="符号干净" />
              <Badge ok={grade.refsTitle as boolean | undefined} label="引用标题" />
              <Badge ok={grade.plausibleLength as boolean | undefined} label={`长度 ${grade.chars}字`} />
            </>
          )}
        </div>
      )}

      {/* Raw output */}
      <div style={{ background: "var(--card)", border: "1px solid var(--border-light)", borderRadius: 6, padding: "8px 10px", fontSize: 11.5, whiteSpace: "pre-wrap", maxHeight: 200, overflowY: "auto", fontFamily: task === "analyze" ? "ui-monospace, SFMono-Regular, monospace" : "inherit", lineHeight: 1.5 }}>
        {row.error ? <span style={{ color: "var(--coral)" }}>{row.error}</span> : raw}
      </div>
    </div>
  );
}

function Badge({ ok, label }: { ok: boolean | undefined; label: string }) {
  if (ok === undefined) return null;
  return (
    <span style={{
      padding: "2px 6px", borderRadius: 4, fontWeight: 600,
      background: ok ? "var(--dx-green-soft)" : "var(--dx-coral-soft)",
      color: ok ? "var(--dx-green)" : "var(--dx-coral)",
    }}>
      {ok ? "✓" : "✗"} {label}
    </span>
  );
}
