"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Play, Users } from "lucide-react";
import { CONGRESS_SAMPLES } from "@/lib/bench-congress";

interface ModelAgg {
  model: string;
  scoreAvg: number;
  latencyAvg: number;
  jsonValidPct: number | null;
  errors: number;
  runs: number;
}

interface Run {
  runId: string;
  createdAt: string;
  models: ModelAgg[];
}

interface CongressBenchData {
  models: string[];
  sampleCount: number;
  runs: Run[];
}

interface RunRow {
  model: string;
  task: string;
  sample_idx: number;
  score: number;
  latency_s: number;
  output_text: string;
  error: string | null;
}

export default function CongressBenchPage() {
  const router = useRouter();
  const [gated, setGated] = useState<"checking" | "allowed" | "forbidden">("checking");
  const [data, setData] = useState<CongressBenchData | null>(null);
  const [pickedModels, setPicked] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; cur: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [expandedRows, setExpandedRows] = useState<RunRow[] | null>(null);

  useEffect(() => {
    fetch("/api/auth/me").then((r) => r.json()).then((d) => {
      if (d.authenticated && d.role === "admin") setGated("allowed");
      else { setGated("forbidden"); router.replace("/"); }
    }).catch(() => { setGated("forbidden"); router.replace("/"); });
  }, [router]);

  const refresh = () => {
    fetch("/api/bench/congress").then((r) => r.json()).then((d: CongressBenchData) => {
      setData(d);
      if (pickedModels.size === 0 && d.models?.length) {
        setPicked(new Set([
          "claude-sonnet-4.6", "claude-opus-4.5",
          "gpt-5-mini", "gemini-2.5-flash",
          "glm-4.7", "qwen3-235b",
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
    const models = Array.from(pickedModels);
    const runId = `crun_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    setProgress({ done: 0, total: models.length, cur: models[0] ?? "" });

    let done = 0;
    for (const m of models) {
      setProgress({ done, total: models.length, cur: m });
      try {
        const r = await fetch("/api/bench/congress", {
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
      done++;
      refresh();
    }

    setProgress(null);
    setRunning(false);
  };

  const toggleRun = async (runId: string) => {
    if (expandedRun === runId) {
      setExpandedRun(null);
      setExpandedRows(null);
      return;
    }
    setExpandedRun(runId);
    setExpandedRows(null);
    const d = await fetch(`/api/bench/${runId}`).then((r) => r.json());
    setExpandedRows((d.rows ?? []).filter((r: RunRow) => r.task === "congress"));
  };

  if (gated !== "allowed") {
    return <div className="flex justify-center p-24"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  }

  const latest = data?.runs?.[0];

  // Group models for the picker
  const groups: Record<string, string[]> = { "Frontier": [], "Fast / Cheap": [], "Chinese": [], "Other": [] };
  for (const m of data?.models ?? []) {
    if (/^(claude-(opus|sonnet)-(4|3)|gpt-5(\.|$)|gpt-4\.1$|gemini-(2\.5-pro|3-pro)|grok-4|^o[13]$)/.test(m)) groups["Frontier"].push(m);
    else if (/(mini|nano|flash|sonnet-4$|grok-3|o4-mini)/.test(m)) groups["Fast / Cheap"].push(m);
    else if (/^(glm|qwen|deepseek|kimi)/.test(m)) groups["Chinese"].push(m);
    else groups["Other"].push(m);
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 28 }}>
        <div>
          <h1 className="page-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Users className="h-6 w-6" />
            Congress Bench
          </h1>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 6 }}>
            Run any model through the full council deliberation ({CONGRESS_SAMPLES.length} evidence packs).
            Scored on persona completeness, adversary quality, and synthesizer coherence.
          </p>
        </div>
      </div>

      {/* Evidence packs preview */}
      <div className="section-card" style={{ marginBottom: 24 }}>
        <h3 style={{ marginBottom: 10 }}>Evidence packs ({CONGRESS_SAMPLES.length})</h3>
        {CONGRESS_SAMPLES.map((s, i) => (
          <div key={s.id} style={{ marginBottom: 8, padding: "8px 10px", background: "var(--bg)", borderRadius: 6, fontSize: 12 }}>
            <strong style={{ marginRight: 8 }}>Pack {i + 1}:</strong>
            <span style={{ color: "var(--text-secondary)" }}>{s.title}</span>
          </div>
        ))}
      </div>

      {/* Model picker */}
      <div className="section-card" style={{ marginBottom: 24 }}>
        <h3 style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          Pick models to bench
        </h3>
        {Object.entries(groups).map(([gname, list]) =>
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
        )}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 16 }}>
          <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
            {pickedModels.size} selected · {pickedModels.size * CONGRESS_SAMPLES.length} deliberations
          </span>
          <button
            type="button"
            onClick={runBench}
            disabled={running || pickedModels.size === 0}
            className="dx-primary"
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {running ? "Running…" : "Run congress bench"}
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

      {/* Latest leaderboard */}
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
                <th title="Avg score across both evidence packs (0-1)">Congress Score</th>
                <th title="% of runs where JSON parsed correctly">JSON Valid</th>
                <th>Latency</th>
                <th>Runs</th>
                <th>Errors</th>
              </tr>
            </thead>
            <tbody>
              {latest.models.map((m) => (
                <tr key={m.model}>
                  <td style={{ fontWeight: 600 }}>{m.model}</td>
                  <td style={{ color: m.scoreAvg >= 0.8 ? "var(--green)" : m.scoreAvg >= 0.5 ? "var(--gold)" : "var(--coral)", fontWeight: 700 }}>
                    {m.scoreAvg.toFixed(2)}
                  </td>
                  <td style={{ color: "var(--text-tertiary)" }}>
                    {m.jsonValidPct === null ? "—" : `${m.jsonValidPct}%`}
                  </td>
                  <td>{m.latencyAvg.toFixed(1)}s</td>
                  <td style={{ color: "var(--text-tertiary)" }}>{m.runs}</td>
                  <td style={{ color: m.errors > 0 ? "var(--coral)" : "var(--text-tertiary)" }}>
                    {m.errors || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* History */}
      {data && data.runs.length > 0 && (
        <div className="section-card">
          <h3 style={{ marginBottom: 12 }}>History ({data.runs.length} runs)</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {data.runs.map((r) => (
              <div key={r.runId} style={{ background: "var(--bg)", border: "1px solid var(--border-light)", borderRadius: 6, overflow: "hidden" }}>
                <button
                  type="button"
                  onClick={() => toggleRun(r.runId)}
                  style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", background: "transparent", border: 0, cursor: "pointer", fontSize: 12, textAlign: "left" }}
                >
                  <span style={{ color: "var(--text-tertiary)" }}>{new Date(r.createdAt).toLocaleString()}</span>
                  <span style={{ flex: 1, color: "var(--text)" }}>
                    {r.models.length} models · best: <strong>{r.models[0]?.model}</strong> ({r.models[0]?.scoreAvg.toFixed(2)})
                  </span>
                  <code style={{ color: "var(--text-tertiary)", fontSize: 11 }}>{r.runId}</code>
                </button>
                {expandedRun === r.runId && (
                  <CongressRunDetail rows={expandedRows} />
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CongressRunDetail({ rows }: { rows: RunRow[] | null }) {
  const [activeModel, setActiveModel] = useState<string | null>(null);
  if (!rows) return <div style={{ padding: 12, fontSize: 12, color: "var(--text-tertiary)" }}><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Loading…</div>;

  const models = [...new Set(rows.map((r) => r.model))];
  const current = activeModel ?? models[0] ?? null;

  return (
    <div style={{ borderTop: "1px solid var(--border-light)", padding: 16 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
        {models.map((m) => (
          <button key={m} type="button" onClick={() => setActiveModel(m)}
            className={`dx-chip ${current === m ? "active" : ""}`} style={{ fontSize: 11 }}>
            {m}
          </button>
        ))}
      </div>
      {current && rows.filter((r) => r.model === current).map((row) => {
        let raw = "";
        let grade: Record<string, unknown> = {};
        try { const p = JSON.parse(row.output_text || "{}"); raw = p.raw ?? ""; grade = p.grade ?? {}; } catch { raw = row.output_text || ""; }
        const scoreColor = row.score >= 0.8 ? "var(--green)" : row.score >= 0.5 ? "var(--gold)" : "var(--coral)";
        const sample = CONGRESS_SAMPLES[row.sample_idx];
        return (
          <div key={row.sample_idx} style={{ marginBottom: 18, border: "1px solid var(--border-light)", borderRadius: 8, overflow: "hidden" }}>
            <div style={{ display: "flex", gap: 10, padding: "8px 12px", background: "var(--bg)", borderBottom: "1px solid var(--border-light)", fontSize: 11.5, alignItems: "center" }}>
              <span style={{ fontWeight: 600 }}>Pack {row.sample_idx + 1}:</span>
              <span style={{ color: "var(--text-secondary)", flex: 1 }}>{sample?.title}</span>
              <span style={{ color: scoreColor, fontWeight: 700 }}>★ {row.score.toFixed(2)}</span>
              <span style={{ color: "var(--text-tertiary)" }}>{row.latency_s}s</span>
            </div>
            {/* Grade badges */}
            {!row.error && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: "8px 12px", borderBottom: "1px solid var(--border-light)" }}>
                {(grade.personasPresent as string[] | undefined)?.map((p) => (
                  <span key={p} style={{ padding: "2px 6px", borderRadius: 4, fontSize: 10.5, fontWeight: 600, background: "var(--dx-green-soft)", color: "var(--dx-green)" }}>✓ {p}</span>
                ))}
                <span style={{ padding: "2px 6px", borderRadius: 4, fontSize: 10.5, fontWeight: 600, background: grade.adversaryPresent ? "var(--dx-green-soft)" : "var(--dx-coral-soft)", color: grade.adversaryPresent ? "var(--dx-green)" : "var(--dx-coral)" }}>
                  {grade.adversaryPresent ? "✓" : "✗"} adversary
                </span>
                <span style={{ padding: "2px 6px", borderRadius: 4, fontSize: 10.5, fontWeight: 600, background: grade.synthesizerOk ? "var(--dx-green-soft)" : "var(--dx-coral-soft)", color: grade.synthesizerOk ? "var(--dx-green)" : "var(--dx-coral)" }}>
                  {grade.synthesizerOk ? "✓" : "✗"} synthesizer
                </span>
                {typeof grade.recommendation === "string" && (
                  <span style={{ padding: "2px 6px", borderRadius: 4, fontSize: 10.5, fontWeight: 600, background: "var(--bg)", color: "var(--text-secondary)", border: "1px solid var(--border-light)" }}>
                    → {grade.recommendation} ({typeof grade.confidence === "number" ? `${Math.round(grade.confidence * 100)}%` : "?"})
                  </span>
                )}
              </div>
            )}
            {/* Synthesizer text */}
            <div style={{ padding: "10px 12px", fontSize: 12.5, lineHeight: 1.6, maxHeight: 280, overflowY: "auto", whiteSpace: "pre-wrap", color: row.error ? "var(--coral)" : "var(--text)" }}>
              {row.error ? row.error : (() => {
                try {
                  const obj = JSON.parse(stripFences(raw));
                  return obj?.personas?.synthesizer ?? raw;
                } catch { return raw; }
              })()}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function stripFences(s: string): string {
  let t = s.trim();
  if (t.startsWith("```")) { const i = t.indexOf("\n"); t = t.slice(i + 1); if (t.endsWith("```")) t = t.slice(0, -3); }
  return t.trim();
}
