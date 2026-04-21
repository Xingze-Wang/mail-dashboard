"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Play, Zap, BarChart3, ChevronDown, ChevronRight, FileText, Mail } from "lucide-react";
import { SAMPLES } from "./samples";

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

  const [progress, setProgress] = useState<{ done: number; total: number; cur: string } | null>(null);

  const runBench = async () => {
    if (pickedModels.size === 0) return;
    setRunning(true);
    setError(null);
    const models = Array.from(pickedModels);
    // Single shared runId across the per-model fan-out
    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    setProgress({ done: 0, total: models.length, cur: models[0] ?? "" });

    let succeeded = 0;
    for (const m of models) {
      setProgress({ done: succeeded, total: models.length, cur: m });
      try {
        const r = await fetch("/api/bench", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ models: [m], runId }),
        });
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          setError(`${m}: ${e.error || `HTTP ${r.status}`}`);
        }
      } catch (e) {
        setError(`${m}: ${String(e)}`);
      }
      succeeded++;
      // Refresh after each model so the leaderboard fills in live.
      refresh();
    }

    setProgress(null);
    setRunning(false);
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

  // Auto-load the latest run's detail so the Compare Outputs panel is
  // populated on first paint — no clicking required.
  const [latestDetail, setLatestDetail] = useState<RunDetail | null>(null);
  useEffect(() => {
    if (!data?.runs?.[0]?.runId) return;
    fetch(`/api/bench/${data.runs[0].runId}`)
      .then((r) => r.json())
      .then(setLatestDetail)
      .catch(() => {});
  }, [data?.runs?.[0]?.runId]);

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
        {progress && (
          <div style={{ marginTop: 12, padding: 8, background: "var(--bg)", borderRadius: 6, fontSize: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <span>Running: <strong>{progress.cur}</strong></span>
              <span style={{ color: "var(--text-tertiary)" }}>{progress.done} / {progress.total}</span>
            </div>
            <div style={{ height: 4, background: "var(--border-light)", borderRadius: 2, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${(progress.done / progress.total) * 100}%`, background: "var(--blue)", transition: "width 0.3s" }} />
            </div>
          </div>
        )}
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

      {/* Compare outputs — left: paper, right: every model's email stacked */}
      {latestDetail && <CompareOutputs detail={latestDetail} />}

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

// ───────────────────────── Compare Outputs (paper-left, models-right) ─────────────────────────

function CompareOutputs({ detail }: { detail: RunDetail }) {
  const [paperIdx, setPaperIdx] = useState(0);
  const [task, setTask] = useState<"intro" | "analyze">("intro");

  // Group rows by sample → task → model
  const grouped = useMemo(() => {
    const m = new Map<number, Map<string, Map<string, RunDetail["rows"][0]>>>();
    for (const r of detail.rows) {
      const samp = m.get(r.sample_idx) ?? new Map();
      const tasks = samp.get(r.task) ?? new Map();
      tasks.set(r.model, r);
      samp.set(r.task, tasks);
      m.set(r.sample_idx, samp);
    }
    return m;
  }, [detail.rows]);

  const paper = SAMPLES[paperIdx];
  const modelOutputs = useMemo(() => {
    const inner = grouped.get(paperIdx)?.get(task);
    if (!inner) return [];
    return Array.from(inner.values()).sort((a, b) => b.score - a.score);
  }, [grouped, paperIdx, task]);

  const extractRaw = (row: RunDetail["rows"][0]): { raw: string; grade: Record<string, unknown> } => {
    try {
      const parsed = JSON.parse(row.output_text || "{}");
      return { raw: parsed.raw ?? "", grade: parsed.grade ?? {} };
    } catch {
      return { raw: row.output_text || "", grade: {} };
    }
  };

  return (
    <div className="section-card" style={{ marginBottom: 24, padding: 0, overflow: "hidden" }}>
      {/* Header tab strip */}
      <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <h3 style={{ margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
            <Mail className="h-4 w-4" />
            Compare outputs
            <span className="lead-count" style={{ marginLeft: 6 }}>side-by-side</span>
          </h3>
          {/* Task switcher */}
          <div className="dx-chip-group">
            {(["intro", "analyze"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTask(t)}
                className={`dx-chip ${task === t ? "active" : ""}`}
              >
                {t === "intro" ? "Email intro" : "Analysis JSON"}
              </button>
            ))}
          </div>
        </div>
        {/* Paper picker */}
        <div className="dx-chip-group">
          {SAMPLES.map((s, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setPaperIdx(i)}
              className={`dx-chip ${paperIdx === i ? "active" : ""}`}
              style={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              Paper {i + 1}: {s.title.slice(0, 40)}…
            </button>
          ))}
        </div>
      </div>

      {/* Split: paper on left, model emails on right */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(280px, 1fr) 2fr", gap: 0 }}>
        {/* LEFT — paper */}
        <div style={{ padding: 20, borderRight: "1px solid var(--border)", background: "var(--bg)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>
            <FileText style={{ width: 12, height: 12 }} />
            Paper input
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10, lineHeight: 1.35 }}>{paper.title}</div>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.6, marginBottom: 14 }}>
            {paper.abstract}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 4 }}>
            <strong>Authors:</strong> {paper.authors.join(", ")}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 14 }}>
            <strong>Emails:</strong> {paper.emails.join(", ")}
          </div>
          <div style={{ padding: 10, background: "var(--card)", borderRadius: 6, border: "1px solid var(--border-light)" }}>
            <div style={{ fontSize: 10.5, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6, fontWeight: 600 }}>
              Ground truth
            </div>
            <div style={{ fontSize: 11.5, lineHeight: 1.7 }}>
              <div><strong>Compute:</strong> {paper.truth.compute}</div>
              <div><strong>Direction:</strong> {paper.truth.direction}</div>
              <div><strong>Chinese author:</strong> {paper.truth.chinese ? "yes" : "no"}</div>
            </div>
          </div>
        </div>

        {/* RIGHT — every model's output stacked, sorted by score */}
        <div style={{ padding: "20px 20px 24px", maxHeight: 720, overflowY: "auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 12 }}>
            <Mail style={{ width: 12, height: 12 }} />
            {modelOutputs.length} models · sorted by score
          </div>
          {modelOutputs.length === 0 && (
            <div style={{ color: "var(--text-tertiary)", fontSize: 12 }}>No output for this task yet.</div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {modelOutputs.map((row) => {
              const { raw, grade } = extractRaw(row);
              const scoreColor = row.score >= 0.85 ? "var(--green)"
                : row.score >= 0.5 ? "var(--gold)" : "var(--coral)";
              return (
                <div key={row.model} style={{ border: "1px solid var(--border-light)", borderRadius: 8, overflow: "hidden", background: "var(--card)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 12px", background: "var(--bg)", borderBottom: "1px solid var(--border-light)", fontSize: 11.5 }}>
                    <span style={{ fontWeight: 700 }}>{row.model}</span>
                    <span style={{ color: scoreColor, fontWeight: 600 }}>★ {row.score.toFixed(2)}</span>
                    <span style={{ color: "var(--text-tertiary)" }}>{row.latency_s}s</span>
                    <span style={{ color: "var(--text-tertiary)" }}>{row.tokens_out ?? "?"} tok</span>
                    <div style={{ flex: 1 }} />
                    {/* Per-fact badges inline */}
                    {!row.error && (
                      <div style={{ display: "flex", gap: 4 }}>
                        {task === "analyze" && (
                          <>
                            <Badge ok={grade.correctNeedsCompute as boolean | undefined} label="算力" />
                            <Badge ok={grade.correctLevel as boolean | undefined} label="等级" />
                            <Badge ok={grade.correctDirection as boolean | undefined} label="方向" />
                            <Badge ok={grade.correctChinese as boolean | undefined} label="中国人" />
                          </>
                        )}
                        {task === "intro" && (
                          <>
                            <Badge ok={grade.threePart as boolean | undefined} label="三段论" />
                            <Badge ok={grade.refsTitle as boolean | undefined} label="标题" />
                            <Badge ok={grade.plausibleLength as boolean | undefined} label={`${grade.chars}字`} />
                          </>
                        )}
                      </div>
                    )}
                  </div>
                  <div style={{
                    padding: 12,
                    fontSize: task === "intro" ? 13.5 : 11.5,
                    lineHeight: task === "intro" ? 1.7 : 1.5,
                    fontFamily: task === "analyze" ? "ui-monospace, SFMono-Regular, monospace" : "inherit",
                    color: row.error ? "var(--coral)" : "var(--text)",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}>
                    {row.error ?? raw}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
