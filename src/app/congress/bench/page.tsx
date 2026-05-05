"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Play, ChevronDown, ChevronRight } from "lucide-react";
import { CONGRESS_CONFIGS, CONGRESS_SAMPLES } from "@/lib/bench-congress";

// ── Types ──────────────────────────────────────────────────────────────────

interface ConfigResult {
  configId: string;
  configName: string;
  recommendation: "approve" | "reject" | "defer" | null;
  confidence: number | null;
  change: { kind: string; details: string } | null;
  rationale: string | null;
  extraFields: Record<string, string>;
  personas: Record<string, string>;
  latency_s: number;
  error: string | null;
}

interface SampleRun {
  sampleIdx: number;
  sampleTitle: string;
  configs: ConfigResult[];
}

interface BenchRun {
  runId: string;
  createdAt: string;
  samples: SampleRun[];
}

interface BenchData {
  configs: { id: string; name: string; tagline: string; color: string; model: string }[];
  samples: { id: string; title: string }[];
  runs: BenchRun[];
}

// ── Constants ──────────────────────────────────────────────────────────────

const REC_STYLE: Record<string, { label: string; bg: string; text: string; border: string }> = {
  approve: { label: "Approve", bg: "bg-emerald-50 dark:bg-emerald-950/40", text: "text-emerald-800 dark:text-emerald-300", border: "border-emerald-200 dark:border-emerald-800" },
  reject:  { label: "Reject",  bg: "bg-red-50 dark:bg-red-950/40",     text: "text-red-800 dark:text-red-300",     border: "border-red-200 dark:border-red-800"     },
  defer:   { label: "Defer",   bg: "bg-amber-50 dark:bg-amber-950/40", text: "text-amber-800 dark:text-amber-300", border: "border-amber-200 dark:border-amber-800" },
};

const CONFIG_ACCENT: Record<string, string> = {
  conservative: "border-l-zinc-400 dark:border-l-zinc-600",
  expansionist: "border-l-emerald-500 dark:border-l-emerald-400",
  empiricist:   "border-l-blue-500 dark:border-l-blue-400",
};

// ── Main page ──────────────────────────────────────────────────────────────

export default function CongressBenchPage() {
  const router = useRouter();
  const [gated, setGated] = useState<"checking" | "allowed" | "forbidden">("checking");
  const [data, setData] = useState<BenchData | null>(null);
  const [selectedSample, setSelectedSample] = useState<string>(CONGRESS_SAMPLES[0].id);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/auth/me").then((r) => r.json()).then((d) => {
      if (d.authenticated && d.role === "admin") setGated("allowed");
      else { setGated("forbidden"); router.replace("/"); }
    }).catch(() => { setGated("forbidden"); router.replace("/"); });
  }, [router]);

  const refresh = useCallback(() => {
    fetch("/api/bench/congress").then((r) => r.json()).then((d: BenchData) => setData(d))
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => { if (gated === "allowed") refresh(); }, [gated, refresh]);

  const runBench = async () => {
    setRunning(true);
    setError(null);
    try {
      const r = await fetch("/api/bench/congress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sampleId: selectedSample }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        setError(`HTTP ${r.status}: ${e.error ?? "unknown"}`);
      } else {
        refresh();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  if (gated !== "allowed") {
    return <div className="flex justify-center p-24"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  }

  const latestRun = data?.runs?.[0];

  return (
    <div style={{ maxWidth: 880, margin: "0 auto" }}>
      <header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>
            Congress · Bench
          </div>
          <h1 className="page-title">Congress configurations</h1>
          <p style={{ fontSize: 13, color: "var(--text-tertiary)", marginTop: 4 }}>
            Three advisory firms — same evidence, different lenses. Watch where they agree and where they split.
          </p>
        </div>
      </header>

      {/* Config cards — who is at the table */}
      <section className="mb-6">
        <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
          Active configurations
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {CONGRESS_CONFIGS.map((cfg) => (
            <div key={cfg.id} className={`rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900 border-l-4 ${CONFIG_ACCENT[cfg.id] ?? ""}`}>
              <div className="mb-1 text-[13px] font-medium">{cfg.name}</div>
              <div className="mb-2 text-[11px] text-zinc-500 dark:text-zinc-400">{cfg.tagline}</div>
              <div className="flex flex-wrap gap-1">
                <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                  {cfg.model}
                </span>
                {Object.keys(cfg.personaOverrides).map((k) => (
                  <span key={k} className="rounded bg-sky-50 px-1.5 py-0.5 text-[10px] text-sky-700 dark:bg-sky-950 dark:text-sky-300">
                    {k.replace("_", " ")} ↑
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Evidence pack picker + run button */}
      <section className="mb-6 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-3 text-[11px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
          Run a new session
        </div>
        <div className="mb-4 space-y-2">
          {CONGRESS_SAMPLES.map((s) => (
            <label key={s.id} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
              selectedSample === s.id
                ? "border-sky-300 bg-sky-50 dark:border-sky-700 dark:bg-sky-950/30"
                : "border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700"
            }`}>
              <input
                type="radio"
                name="sample"
                value={s.id}
                checked={selectedSample === s.id}
                onChange={() => setSelectedSample(s.id)}
                className="mt-0.5 shrink-0 accent-sky-600"
              />
              <div>
                <div className="text-[13px] font-medium">{s.title}</div>
              </div>
            </label>
          ))}
        </div>
        <div className="flex items-center justify-between">
          <p className="text-[12px] text-zinc-500 dark:text-zinc-400">
            All {CONGRESS_CONFIGS.length} configs run in parallel · ~90s total
          </p>
          <button
            onClick={runBench}
            disabled={running}
            className="inline-flex items-center gap-2 rounded-md border border-sky-300 bg-sky-100 px-4 py-2 text-[13px] font-medium text-sky-800 hover:bg-sky-200 disabled:opacity-60 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200"
          >
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {running ? "Running all congresses…" : "Run session"}
          </button>
        </div>
        {error && <div className="mt-3 text-[12px] text-red-600 dark:text-red-400">{error}</div>}
      </section>

      {/* Latest session — side-by-side comparison */}
      {latestRun && <LatestSessionView run={latestRun} />}

      {/* History */}
      {data && data.runs.length > 1 && (
        <section className="mt-6">
          <h2 className="mb-3 text-base font-medium">Session history</h2>
          <div className="space-y-2">
            {data.runs.slice(1).map((run) => (
              <HistoryRow key={run.runId} run={run} expanded={expandedRun === run.runId} onToggle={() => setExpandedRun(expandedRun === run.runId ? null : run.runId)} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ── Latest session view ────────────────────────────────────────────────────

function LatestSessionView({ run }: { run: BenchRun }) {
  const [activeSample, setActiveSample] = useState(0);
  const [activePersona, setActivePersona] = useState<string | null>(null);
  const sample = run.samples[activeSample];

  if (!sample) return null;

  // Divergence signal — are configs unanimous?
  const recs = sample.configs.map((c) => c.recommendation).filter(Boolean);
  const unanimous = recs.length > 0 && new Set(recs).size === 1;
  const split = recs.length > 1 && new Set(recs).size > 1;

  return (
    <section className="mb-6">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-medium">
          Latest session
          <span className="ml-2 text-xs font-normal text-zinc-400 dark:text-zinc-500">
            {new Date(run.createdAt).toLocaleString()}
          </span>
        </h2>
        {/* Divergence badge */}
        {unanimous && (
          <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-[11px] font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
            Unanimous · {recs[0]}
          </span>
        )}
        {split && (
          <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
            Split · needs judgment
          </span>
        )}
      </div>

      {/* Sample tabs if multiple */}
      {run.samples.length > 1 && (
        <div className="mb-3 flex gap-1 border-b border-zinc-200 dark:border-zinc-800">
          {run.samples.map((s, i) => (
            <button
              key={s.sampleIdx}
              onClick={() => setActiveSample(i)}
              className={`-mb-px px-3 pb-2.5 pt-2 text-[12px] border-b-2 transition-colors ${
                activeSample === i
                  ? "border-zinc-900 font-semibold text-zinc-900 dark:border-zinc-100 dark:text-zinc-100"
                  : "border-transparent text-zinc-400 hover:text-zinc-700 dark:text-zinc-500 dark:hover:text-zinc-300"
              }`}
            >
              {s.sampleTitle.length > 40 ? s.sampleTitle.slice(0, 40) + "…" : s.sampleTitle}
            </button>
          ))}
        </div>
      )}

      {/* Side-by-side config columns */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {CONGRESS_CONFIGS.map((cfg) => {
          const result = sample.configs.find((c) => c.configId === cfg.id);
          return (
            <ConfigColumn
              key={cfg.id}
              cfg={cfg}
              result={result ?? null}
              activePersona={activePersona}
              onPersonaClick={(k) => setActivePersona(activePersona === k ? null : k)}
            />
          );
        })}
      </div>

      {/* Persona deep-dive — shows the same persona across all configs */}
      {activePersona && (
        <div className="mt-4 rounded-xl border border-zinc-200 bg-zinc-50 p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mb-3 text-[11px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
            {activePersona.replace("_", " ")} — across all configs
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {CONGRESS_CONFIGS.map((cfg) => {
              const result = sample.configs.find((c) => c.configId === cfg.id);
              const text = result?.personas?.[activePersona] ?? "(no data)";
              return (
                <div key={cfg.id}>
                  <div className={`mb-1.5 text-[11px] font-semibold ${
                    cfg.id === "conservative" ? "text-zinc-600 dark:text-zinc-400"
                    : cfg.id === "expansionist" ? "text-emerald-700 dark:text-emerald-400"
                    : "text-blue-700 dark:text-blue-400"
                  }`}>
                    {cfg.name}
                  </div>
                  <p className="text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-400 whitespace-pre-wrap">
                    {text}
                  </p>
                </div>
              );
            })}
          </div>
          <button
            onClick={() => setActivePersona(null)}
            className="mt-3 text-[11px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
          >
            Close ×
          </button>
        </div>
      )}
    </section>
  );
}

function ConfigColumn({
  cfg, result, activePersona, onPersonaClick,
}: {
  cfg: CongressConfig;
  result: ConfigResult | null;
  activePersona: string | null;
  onPersonaClick: (k: string) => void;
}) {
  const recStyle = result?.recommendation ? REC_STYLE[result.recommendation] : null;
  const accentCls = CONFIG_ACCENT[cfg.id] ?? "";
  const personas = Object.keys(result?.personas ?? {}).filter((k) => k !== "synthesizer");

  return (
    <div className={`rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900 border-l-4 ${accentCls} flex flex-col`}>
      {/* Config header */}
      <div className="border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
        <div className="text-[13px] font-semibold">{cfg.name}</div>
        <div className="text-[11px] text-zinc-400 dark:text-zinc-500">{cfg.tagline}</div>
      </div>

      {result === null || result.error ? (
        <div className="flex flex-1 items-center justify-center p-6 text-[12px] text-zinc-400 dark:text-zinc-600">
          {result?.error ?? "Not run yet"}
        </div>
      ) : (
        <>
          {/* Recommendation */}
          <div className="border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
            {recStyle ? (
              <div className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] font-semibold ${recStyle.bg} ${recStyle.text} ${recStyle.border}`}>
                {recStyle.label}
                {result.confidence !== null && (
                  <span className="text-[10px] font-normal opacity-70">
                    {Math.round(result.confidence * 100)}%
                  </span>
                )}
              </div>
            ) : (
              <span className="text-[12px] text-zinc-400">No recommendation</span>
            )}

            {result.change && (
              <div className="mt-2">
                <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                  {result.change.kind.replace(/_/g, " ")}
                </span>
                <p className="mt-1.5 text-[12px] leading-relaxed text-zinc-700 dark:text-zinc-300">
                  {result.change.details}
                </p>
              </div>
            )}
          </div>

          {/* Rationale */}
          {result.rationale && (
            <div className="border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
              <p className="text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-400 italic">
                &ldquo;{result.rationale}&rdquo;
              </p>
            </div>
          )}

          {/* Config-specific extra field */}
          {Object.entries(result.extraFields).map(([k, v]) => (
            <div key={k} className="border-b border-zinc-100 px-4 py-2 dark:border-zinc-800">
              <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                {k.replace(/_/g, " ")}
              </div>
              <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">{v}</p>
            </div>
          ))}

          {/* Persona stances — clickable to compare across configs */}
          <div className="flex-1 px-4 py-3">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
              Persona stances
            </div>
            <div className="space-y-1.5">
              {personas.map((k) => {
                const text = result.personas[k] ?? "";
                return (
                  <button
                    key={k}
                    onClick={() => onPersonaClick(k)}
                    className={`w-full rounded-md px-2.5 py-2 text-left transition-colors ${
                      activePersona === k
                        ? "bg-sky-50 ring-1 ring-sky-200 dark:bg-sky-950/40 dark:ring-sky-800"
                        : "bg-zinc-50 hover:bg-zinc-100 dark:bg-zinc-800/40 dark:hover:bg-zinc-800"
                    }`}
                  >
                    <div className="mb-0.5 text-[10px] font-semibold capitalize text-zinc-500 dark:text-zinc-400">
                      {k.replace("_", " ")}
                    </div>
                    <p className="text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-400 line-clamp-2">
                      {text}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Footer */}
          <div className="border-t border-zinc-100 px-4 py-2 dark:border-zinc-800">
            <span className="text-[11px] text-zinc-400 dark:text-zinc-600">
              {cfg.model} · {result.latency_s}s
            </span>
          </div>
        </>
      )}
    </div>
  );
}

// ── History row ────────────────────────────────────────────────────────────

function HistoryRow({ run, expanded, onToggle }: { run: BenchRun; expanded: boolean; onToggle: () => void }) {
  // Compute agreement signal across samples
  const signals = run.samples.map((s) => {
    const recs = s.configs.map((c) => c.recommendation).filter(Boolean);
    const unanimous = recs.length > 0 && new Set(recs).size === 1;
    return { title: s.sampleTitle, unanimous, recs };
  });

  return (
    <div className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-400" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-400" />}
        <span className="text-[12px] text-zinc-500 dark:text-zinc-500">
          {new Date(run.createdAt).toLocaleString()}
        </span>
        <div className="flex flex-1 flex-wrap gap-2">
          {signals.map((s, i) => (
            <div key={i} className="flex items-center gap-1">
              <span className="truncate text-[12px] text-zinc-700 dark:text-zinc-300 max-w-[160px]">
                {s.title.length > 35 ? s.title.slice(0, 35) + "…" : s.title}
              </span>
              {s.unanimous ? (
                <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
                  {s.recs[0]}
                </span>
              ) : (
                <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">
                  split
                </span>
              )}
            </div>
          ))}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-zinc-100 px-4 py-4 dark:border-zinc-800">
          {run.samples.map((sample, i) => (
            <div key={i} className={i > 0 ? "mt-4 border-t border-zinc-100 pt-4 dark:border-zinc-800" : ""}>
              <div className="mb-2 text-[11px] font-medium text-zinc-500 dark:text-zinc-400">{sample.sampleTitle}</div>
              <div className="grid grid-cols-3 gap-3">
                {CONGRESS_CONFIGS.map((cfg) => {
                  const r = sample.configs.find((c) => c.configId === cfg.id);
                  const recStyle = r?.recommendation ? REC_STYLE[r.recommendation] : null;
                  return (
                    <div key={cfg.id} className={`rounded-lg border-l-2 bg-zinc-50 px-3 py-2 dark:bg-zinc-800/40 ${CONFIG_ACCENT[cfg.id] ?? ""}`}>
                      <div className="mb-1 text-[10px] font-semibold text-zinc-500 dark:text-zinc-400">{cfg.name}</div>
                      {recStyle ? (
                        <span className={`text-[11px] font-semibold ${recStyle.text}`}>{recStyle.label}</span>
                      ) : (
                        <span className="text-[11px] text-zinc-400">—</span>
                      )}
                      {r?.change && (
                        <p className="mt-1 text-[10px] text-zinc-500 dark:text-zinc-400 line-clamp-2">
                          {r.change.details}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Re-export type so TypeScript doesn't complain about unused import
type CongressConfig = typeof CONGRESS_CONFIGS[0];
