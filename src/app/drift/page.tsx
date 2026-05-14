"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Activity, Play, Check, X, AlertTriangle, Scale, RefreshCw, MessageSquare, Zap, Loader2 } from "lucide-react";

type Tab = "patterns" | "disagreement" | "human";

interface Pattern {
  id: string;
  detected_at: string;
  rep_id: number | null;
  rep_name: string | null;
  category: string;
  ai_phrase: string;
  sales_phrase: string | null;
  occurrence_count: number;
  example_lead_ids: string[] | null;
  prompt_patch: string | null;
  status: "pending" | "accepted" | "ignored";
  accepted_at: string | null;
  accepted_by: string | null;
}

interface Counts {
  pending: number;
  accepted: number;
  ignored: number;
  total: number;
}

const CATEGORY_LABEL: Record<string, string> = {
  ai_misunderstood: "AI misunderstood",
  format: "Format",
  too_verbose: "Too verbose",
  too_robotic: "AI-speak",
  individual_taste: "Individual taste",
};

const CATEGORY_COLOR: Record<string, string> = {
  ai_misunderstood: "#dc2626",
  format: "#2563eb",
  too_verbose: "#d97706",
  too_robotic: "#7c3aed",
  individual_taste: "#6b7280",
};

export default function DriftPage() {
  const router = useRouter();
  const [gated, setGated] = useState<"checking" | "allowed" | "forbidden">("checking");
  const [tab, setTab] = useState<Tab>("patterns");
  const [patterns, setPatterns] = useState<Pattern[]>([]);
  const [counts, setCounts] = useState<Counts>({ pending: 0, accepted: 0, ignored: 0, total: 0 });
  const [byCategory, setByCategory] = useState<Record<string, number>>({});
  const [statusFilter, setStatusFilter] = useState<"pending" | "accepted" | "ignored" | "all">("pending");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [repFilter, setRepFilter] = useState<string>("all"); // "all" | "global" | rep id
  const [loading, setLoading] = useState(true);
  const [mining, setMining] = useState(false);
  const [mineNote, setMineNote] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);
  const [setupHint, setSetupHint] = useState<string | null>(null);
  // Most recent prompt_drift_patterns.detected_at across all rows — gives
  // admin a quick "is the miner actually running?" signal at the top of
  // the page. Pulled with an unfiltered, status=all, limit=1 query so
  // current filters don't hide a fresh miner run.
  const [lastMinedAt, setLastMinedAt] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        if (d.authenticated && d.role === "admin") setGated("allowed");
        else { setGated("forbidden"); router.replace("/"); }
      })
      .catch(() => { setGated("forbidden"); router.replace("/"); });
  }, [router]);

  const reload = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (categoryFilter !== "all") params.set("category", categoryFilter);
    if (repFilter !== "all") params.set("repId", repFilter);
    try {
      const r = await fetch(`/api/drift/patterns?${params.toString()}`, { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Failed");
      setPatterns(d.patterns ?? []);
      setCounts(d.counts ?? { pending: 0, accepted: 0, ignored: 0, total: 0 });
      setByCategory(d.byCategory ?? {});
      setSetupHint(typeof d.setupHint === "string" ? d.setupHint : null);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, categoryFilter, repFilter]);

  useEffect(() => {
    if (gated !== "allowed") return;
    reload();
  }, [gated, reload]);

  // Independent of `reload` so filter changes don't refetch this. We just
  // want the newest detected_at across the whole table.
  useEffect(() => {
    if (gated !== "allowed") return;
    let cancelled = false;
    (async () => {
      try {
        // status param is ignored when value is "all" (server treats null as
        // all), so we just omit it. Patterns come back newest-first.
        const r = await fetch("/api/drift/patterns", { cache: "no-store" });
        const d = await r.json();
        if (cancelled) return;
        const newest = Array.isArray(d.patterns) && d.patterns.length > 0
          ? (d.patterns[0] as Pattern).detected_at
          : null;
        setLastMinedAt(newest);
      } catch {
        // non-fatal — the hint just won't render
      }
    })();
    return () => { cancelled = true; };
  }, [gated, patterns]);

  async function runMiner() {
    setMining(true);
    setMineNote(null);
    try {
      const r = await fetch("/api/drift/mine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days: 90 }),
      });
      const d = await r.json();
      if (!r.ok) {
        setMineNote(`❌ ${d.error ?? "miner failed"}`);
      } else if (d.reason) {
        setMineNote(`ℹ ${d.reason}`);
      } else {
        setMineNote(`✓ mined ${d.mined} new pattern(s) from ${d.pairsConsidered} edited leads (${d.patternsFound} candidates)`);
        await reload();
      }
    } catch (e) {
      setMineNote(`❌ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setMining(false);
    }
  }

  async function actOn(id: string, action: "accept" | "ignore") {
    setActingId(id);
    try {
      const r = await fetch(`/api/drift/patterns/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const d = await r.json();
      if (!r.ok) {
        alert(d.error ?? "action failed");
      } else if (action === "accept" && !d.patchApplied) {
        // Patch wasn't appended (per-rep, empty, or already there). Worth surfacing.
        setMineNote(`ℹ accepted, but patch was not auto-applied (rep-specific, empty, or duplicate).`);
        await reload();
      } else {
        await reload();
      }
    } finally {
      setActingId(null);
    }
  }

  if (gated === "checking") return null;
  if (gated === "forbidden") return null;

  return (
    <div>
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2.5 text-lg font-medium">
            <Activity className="h-5 w-5 text-zinc-500" />
            Drift
          </h1>
          <p className="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400">
            Patterns mined from sales edits. Accepted patterns are appended to <code className="font-mono text-[12px]">pipeline_intro_prompt</code>.
          </p>
          <p className="mt-1 text-[11px] text-zinc-400 dark:text-zinc-600">
            last mined: {lastMinedAt ? new Date(lastMinedAt).toLocaleString() : "never run"}
          </p>
        </div>
        {tab === "patterns" && (
          <button
            onClick={runMiner}
            disabled={mining}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-sky-300 bg-sky-100 px-3 py-1.5 text-[13px] font-medium text-sky-800 hover:bg-sky-200 disabled:opacity-60 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200 dark:hover:bg-sky-900"
          >
            <Play className="h-3.5 w-3.5" />
            {mining ? "Mining…" : "Run miner (90d)"}
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="mb-5 flex gap-1 border-b border-zinc-200 dark:border-zinc-800">
        <TabButton active={tab === "patterns"} onClick={() => setTab("patterns")}>
          <AlertTriangle className="h-3.5 w-3.5" /> Patterns
        </TabButton>
        <TabButton active={tab === "disagreement"} onClick={() => setTab("disagreement")}>
          <Scale className="h-3.5 w-3.5" /> Judge vs Human
        </TabButton>
        <TabButton active={tab === "human"} onClick={() => setTab("human")}>
          <MessageSquare className="h-3.5 w-3.5" /> Human Signals
        </TabButton>
      </div>

      {tab === "disagreement" && <DisagreementView />}
      {tab === "human" && <HumanSignalsView />}
      {tab === "patterns" && <PatternsView
        mineNote={mineNote}
        setupHint={setupHint}
        counts={counts}
        byCategory={byCategory}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        categoryFilter={categoryFilter}
        setCategoryFilter={setCategoryFilter}
        repFilter={repFilter}
        setRepFilter={setRepFilter}
        loading={loading}
        patterns={patterns}
        actingId={actingId}
        actOn={actOn}
        onSwitchToHuman={() => setTab("human")}
      />}
    </div>
  );
}

/* === Patterns view (extracted so Judge-vs-Human can live alongside) === */
function PatternsView(props: {
  mineNote: string | null;
  setupHint: string | null;
  counts: Counts;
  byCategory: Record<string, number>;
  statusFilter: "pending" | "accepted" | "ignored" | "all";
  setStatusFilter: (s: "pending" | "accepted" | "ignored" | "all") => void;
  categoryFilter: string;
  setCategoryFilter: (s: string) => void;
  onSwitchToHuman: () => void;
  repFilter: string;
  setRepFilter: (s: string) => void;
  loading: boolean;
  patterns: Pattern[];
  actingId: string | null;
  actOn: (id: string, action: "accept" | "ignore") => void;
}) {
  const { mineNote, setupHint, counts, byCategory, statusFilter, setStatusFilter, categoryFilter, setCategoryFilter, repFilter, setRepFilter, loading, patterns, actingId, actOn, onSwitchToHuman } = props;
  return (
    <div>

      {setupHint && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-3 text-[13px] leading-relaxed text-amber-800 dark:border-amber-800/40 dark:bg-amber-950/30 dark:text-amber-300">
          ⚠ {setupHint}
        </div>
      )}

      {mineNote && (
        <div className="mb-4 rounded-lg border border-zinc-200 bg-zinc-50 px-3.5 py-3 text-[13px] text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
          {mineNote}
        </div>
      )}

      {/* Stat row */}
      <div className="mb-6 grid grid-cols-4 gap-3">
        <StatCard label="Total mined" value={counts.total} />
        <StatCard label="Pending review" value={counts.pending} emphasis />
        <StatCard label="Accepted" value={counts.accepted} />
        <StatCard label="Ignored" value={counts.ignored} />
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Pill active={statusFilter === "pending"} onClick={() => setStatusFilter("pending")}>Pending ({counts.pending})</Pill>
        <Pill active={statusFilter === "accepted"} onClick={() => setStatusFilter("accepted")}>Accepted ({counts.accepted})</Pill>
        <Pill active={statusFilter === "ignored"} onClick={() => setStatusFilter("ignored")}>Ignored ({counts.ignored})</Pill>
        <Pill active={statusFilter === "all"} onClick={() => setStatusFilter("all")}>All ({counts.total})</Pill>

        <div className="mx-1 h-4 w-px bg-zinc-200 dark:bg-zinc-700" />

        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className={selectCls}
        >
          <option value="all">All categories</option>
          {Object.keys(CATEGORY_LABEL).map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABEL[c]} ({byCategory[c] ?? 0})
            </option>
          ))}
        </select>

        <select
          value={repFilter}
          onChange={(e) => setRepFilter(e.target.value)}
          className={selectCls}
        >
          <option value="all">All reps</option>
          <option value="global">Global only</option>
          <option value="1">Leo (1)</option>
          <option value="2">Yujie (2)</option>
          <option value="3">Ethan (3)</option>
        </select>
      </div>

      {/* Pattern list */}
      {loading ? (
        <div className="h-48 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" />
      ) : patterns.length === 0 ? (
        <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-8 text-center dark:border-zinc-800 dark:bg-zinc-900">
          <AlertTriangle className="mx-auto mb-3 h-6 w-6 text-zinc-400" />
          <h3 className="mb-2 text-[14px] font-medium text-zinc-700 dark:text-zinc-300">No mined patterns yet</h3>
          <p className="mb-4 text-[13px] text-zinc-500 dark:text-zinc-400">
            The LLM miner needs ≥3 edited drafts (with edit reasons or notes) within the lookback window to detect a pattern. At the team&apos;s current edit volume that threshold often isn&apos;t met — but the raw qualitative signal is still there.
          </p>
          <button
            onClick={onSwitchToHuman}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 px-3 py-1.5 text-[13px] text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            <MessageSquare className="h-3.5 w-3.5" /> See raw human signals →
          </button>
          <p className="mt-3 text-[11px] text-zinc-400 dark:text-zinc-600">You can also click <strong>Run miner</strong> above to force a fresh pass.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {patterns.map((p) => (
            <PatternCard
              key={p.id}
              p={p}
              busy={actingId === p.id}
              onAccept={() => actOn(p.id, "accept")}
              onIgnore={() => actOn(p.id, "ignore")}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3.5 pb-2.5 pt-2 text-[13px] transition-colors ${
        active
          ? "border-zinc-900 font-semibold text-zinc-900 dark:border-zinc-100 dark:text-zinc-100"
          : "border-transparent font-normal text-zinc-400 hover:text-zinc-700 dark:text-zinc-500 dark:hover:text-zinc-300"
      }`}
    >
      {children}
    </button>
  );
}

interface DisagreementLead {
  id: string;
  title: string | null;
  draft_original_html: string | null;
  draft_html: string | null;
  draft_edit_distance: number | null;
  edit_reasons: string[] | null;
  edit_note: string | null;
  judge_avg: number | null;
  judge_prompt_leak: boolean | null;
  judge_at: string | null;
  judge_verdicts: Array<{ judge: string; score_0_10: number; reasons: string; prompt_leak: boolean }> | null;
  sent_at: string | null;
  draft_model: string | null;
}

interface DisagreementData {
  thresholds: { JUDGE_HIGH: number; JUDGE_LOW: number; EDIT_HEAVY: number; EDIT_LIGHT: number };
  quadrants: {
    judgeLovedSalesHated: DisagreementLead[];
    judgeHatedSalesKept: DisagreementLead[];
    bothLoved: DisagreementLead[];
    bothHated: DisagreementLead[];
  };
  counts: {
    judgeLovedSalesHated: number;
    judgeHatedSalesKept: number;
    bothLoved: number;
    bothHated: number;
    middle: number;
    total: number;
  };
}

function DisagreementView() {
  const [data, setData] = useState<DisagreementData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [rejudgeId, setRejudgeId] = useState<string | null>(null);
  const [quadrant, setQuadrant] = useState<keyof DisagreementData["quadrants"]>("judgeLovedSalesHated");

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/drift/disagreement", { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "failed");
      setData(d);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  async function reJudge(leadId: string) {
    setRejudgeId(leadId);
    try {
      const r = await fetch("/api/drift/rejudge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadId }),
      });
      const d = await r.json();
      if (!r.ok) alert(d.error ?? "re-judge failed");
      await reload();
    } finally {
      setRejudgeId(null);
    }
  }

  if (loading) return <div className="skeleton" style={{ height: 200 }} />;
  if (err) return <div className="empty-state"><h3>Error</h3><p>{err}</p></div>;
  if (!data) return null;

  const c = data.counts;
  const noData = c.total === 0;
  if (noData) {
    return (
      <div className="empty-state">
        <div className="empty-icon"><Scale style={{ width: 22, height: 22 }} /></div>
        <h3>No judged sent leads yet</h3>
        <p>
          This view compares the judge ensemble's score (on the AI's original draft) with how much sales edited it.
          Re-judge any sent lead from a row below, or wait for new sends to accumulate data.
        </p>
      </div>
    );
  }

  const t = data.thresholds;
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 20 }}>
        <QuadCard
          title="Judges loved, sales hated"
          subtitle={`score ≥${t.JUDGE_HIGH}, edit ≥${t.EDIT_HEAVY}`}
          count={c.judgeLovedSalesHated}
          hint="Rubric blind spot"
          tone="alert"
          active={quadrant === "judgeLovedSalesHated"}
          onClick={() => setQuadrant("judgeLovedSalesHated")}
        />
        <QuadCard
          title="Judges hated, sales kept"
          subtitle={`score <${t.JUDGE_LOW}, edit <${t.EDIT_LIGHT}`}
          count={c.judgeHatedSalesKept}
          hint="Rubric over-penalizing"
          tone="alert"
          active={quadrant === "judgeHatedSalesKept"}
          onClick={() => setQuadrant("judgeHatedSalesKept")}
        />
        <QuadCard
          title="Both loved"
          subtitle="agreement"
          count={c.bothLoved}
          hint="Working as intended"
          tone="ok"
          active={quadrant === "bothLoved"}
          onClick={() => setQuadrant("bothLoved")}
        />
        <QuadCard
          title="Both hated"
          subtitle="agreement"
          count={c.bothHated}
          hint="AI is genuinely weak"
          tone="ok"
          active={quadrant === "bothHated"}
          onClick={() => setQuadrant("bothHated")}
        />
      </div>

      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 10 }}>
        {c.total} judged leads total, {c.middle} in the middle (not shown).
      </div>

      <DisagreementList
        leads={data.quadrants[quadrant]}
        rejudgeId={rejudgeId}
        onReJudge={reJudge}
      />

      {/* ── Helper predictions panel — same axis (LLM judgment vs reality)
          but applied to the helper's claims about leads. Only renders for
          admin role (predictions/recent enforces this server-side). ── */}
      <HelperPredictionsPanel />
    </div>
  );
}

interface HelperPredictionRow {
  id: string;
  rep_id: number;
  claim: string;
  target_event: string;
  target_lead_id: string | null;
  resolved_correct: boolean | null;
  resolution_note: string | null;
  judge_avg: number | null;
  judge_verdicts: Array<{ judge: string; score_0_10: number; reasons: string }> | null;
  made_at: string;
  resolved_at: string | null;
}

interface PredictionsRecentResp {
  predictions: HelperPredictionRow[];
  accuracy: { resolved: number; correct: number; ratio: number | null };
}

function HelperPredictionsPanel() {
  const [data, setData] = useState<PredictionsRecentResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/help/predictions/recent", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setErr(d.error);
        else setData(d);
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return null;
  if (err) {
    // Forbidden is fine — the panel just hides for non-admin.
    if (/forbidden|unauthorized/i.test(err)) return null;
    return null;
  }
  if (!data || data.predictions.length === 0) return null;

  const resolved = data.predictions.filter((p) => p.resolved_correct !== null);
  const buckets = {
    rightThoughtful: resolved.filter((p) => p.resolved_correct === true && (p.judge_avg ?? 0) >= 7),
    rightLazy: resolved.filter((p) => p.resolved_correct === true && (p.judge_avg ?? 10) < 5),
    wrongThoughtful: resolved.filter((p) => p.resolved_correct === false && (p.judge_avg ?? 0) >= 7),
    wrongLazy: resolved.filter((p) => p.resolved_correct === false && (p.judge_avg ?? 10) < 5),
  };

  return (
    <div style={{ marginTop: 32, paddingTop: 24, borderTop: "1px solid var(--border)" }}>
      <div style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Helper predictions</h2>
        <p style={{ fontSize: 12, color: "var(--muted)", margin: 0 }}>
          Outcome × judge for resolved predictions. Acc{" "}
          {data.accuracy.ratio != null ? `${Math.round(data.accuracy.ratio * 100)}%` : "—"}
          {" "}
          ({data.accuracy.correct}/{data.accuracy.resolved}). Total tracked: {data.predictions.length}.
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 16 }}>
        <PredQuad title="Right + thoughtful" subtitle="outcome correct, judge ≥7" count={buckets.rightThoughtful.length} hint="Validated reasoning" tone="ok" />
        <PredQuad title="Right + lazy" subtitle="outcome correct, judge <5" count={buckets.rightLazy.length} hint="Right by accident — lower confidence" tone="alert" />
        <PredQuad title="Wrong + thoughtful" subtitle="outcome wrong, judge ≥7" count={buckets.wrongThoughtful.length} hint="World surprised us" tone="ok" />
        <PredQuad title="Wrong + lazy" subtitle="outcome wrong, judge <5" count={buckets.wrongLazy.length} hint="Stop making this kind of claim" tone="alert" />
      </div>

      <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
        <table style={{ width: "100%", fontSize: 12 }}>
          <thead style={{ background: "var(--bg)" }}>
            <tr style={{ color: "var(--muted)" }}>
              <th style={{ textAlign: "left", padding: "8px 12px" }}>Claim</th>
              <th style={{ textAlign: "center", padding: "8px 12px", width: 80 }}>Outcome</th>
              <th style={{ textAlign: "center", padding: "8px 12px", width: 100 }}>Judge avg</th>
              <th style={{ textAlign: "left", padding: "8px 12px", width: 140 }}>Resolution</th>
              <th style={{ textAlign: "right", padding: "8px 12px", width: 90 }}>Resolved</th>
            </tr>
          </thead>
          <tbody>
            {data.predictions.slice(0, 20).map((p) => {
              const isOpen = expandedId === p.id;
              return (
                <FragmentRow
                  key={p.id}
                  pred={p}
                  isOpen={isOpen}
                  onToggle={() => setExpandedId(isOpen ? null : p.id)}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FragmentRow({ pred, isOpen, onToggle }: { pred: HelperPredictionRow; isOpen: boolean; onToggle: () => void }) {
  const outcomeBadge =
    pred.resolved_correct === null ? (
      <span style={{ fontSize: 10, color: "var(--muted)" }}>pending</span>
    ) : pred.resolved_correct ? (
      <span style={{ fontSize: 11, color: "#16a34a", fontWeight: 600 }}>right</span>
    ) : (
      <span style={{ fontSize: 11, color: "#dc2626", fontWeight: 600 }}>wrong</span>
    );
  const judgeBadge =
    pred.judge_avg == null ? (
      <span style={{ fontSize: 10, color: "var(--muted)" }}>—</span>
    ) : (
      <span
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: pred.judge_avg >= 7 ? "#16a34a" : pred.judge_avg < 5 ? "#dc2626" : "var(--text-secondary)",
        }}
      >
        {pred.judge_avg.toFixed(1)}/10
      </span>
    );

  return (
    <>
      <tr style={{ borderTop: "1px solid var(--border-light)", cursor: "pointer" }} onClick={onToggle}>
        <td style={{ padding: "8px 12px", color: "var(--text)" }}>{pred.claim.length > 120 ? `${pred.claim.slice(0, 120)}…` : pred.claim}</td>
        <td style={{ padding: "8px 12px", textAlign: "center" }}>{outcomeBadge}</td>
        <td style={{ padding: "8px 12px", textAlign: "center" }}>{judgeBadge}</td>
        <td style={{ padding: "8px 12px", color: "var(--text-secondary)" }}>{pred.resolution_note ?? "—"}</td>
        <td style={{ padding: "8px 12px", textAlign: "right", color: "var(--muted)", fontSize: 11 }}>
          {pred.resolved_at ? new Date(pred.resolved_at).toLocaleDateString() : "—"}
        </td>
      </tr>
      {isOpen && pred.judge_verdicts && (
        <tr style={{ background: "var(--bg)" }}>
          <td colSpan={5} style={{ padding: "10px 16px" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {pred.judge_verdicts.map((v) => (
                <div key={v.judge} style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                  <strong style={{ color: "var(--text)" }}>{v.judge}</strong>{" "}
                  <span style={{ color: v.score_0_10 >= 7 ? "#16a34a" : v.score_0_10 < 5 ? "#dc2626" : "var(--text-tertiary)" }}>
                    {v.score_0_10}/10
                  </span>{" "}
                  — {v.reasons}
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function PredQuad({ title, subtitle, count, hint, tone }: { title: string; subtitle: string; count: number; hint: string; tone: "alert" | "ok" }) {
  const accent = tone === "alert" ? "#dc2626" : "#16a34a";
  return (
    <div style={{ padding: 12, border: "1px solid var(--border)", borderRadius: 10, background: "var(--card)" }}>
      <div style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.4 }}>{title}</div>
      <div style={{ fontSize: 24, fontWeight: 600, color: accent, lineHeight: 1.1, marginTop: 4 }}>{count}</div>
      <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>{subtitle}</div>
      <div style={{ fontSize: 11, color: accent, marginTop: 6, fontWeight: 500 }}>{hint}</div>
    </div>
  );
}

function QuadCard({
  title, subtitle, count, hint, tone, active, onClick,
}: {
  title: string;
  subtitle: string;
  count: number;
  hint: string;
  tone: "alert" | "ok";
  active: boolean;
  onClick: () => void;
}) {
  const accent = tone === "alert" ? "#dc2626" : "#16a34a";
  return (
    <button
      onClick={onClick}
      style={{
        padding: 14,
        border: "1px solid " + (active ? accent : "var(--border)"),
        borderRadius: 10,
        background: active ? accent + "0d" : "var(--card)",
        textAlign: "left",
        cursor: "pointer",
        transition: "all 120ms",
      }}
    >
      <div style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.4 }}>{title}</div>
      <div style={{ fontSize: 28, fontWeight: 600, color: accent, lineHeight: 1.1, marginTop: 4 }}>{count}</div>
      <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>{subtitle}</div>
      <div style={{ fontSize: 11, color: accent, marginTop: 6, fontWeight: 500 }}>{hint}</div>
    </button>
  );
}

function DisagreementList({
  leads, rejudgeId, onReJudge,
}: {
  leads: DisagreementLead[];
  rejudgeId: string | null;
  onReJudge: (id: string) => void;
}) {
  if (leads.length === 0) {
    return (
      <div style={{ padding: 20, color: "var(--muted)", textAlign: "center", fontSize: 13, lineHeight: 1.6 }}>
        No leads in this quadrant yet. As sends + judge runs accumulate, rows will surface here — pick another quadrant to see what&apos;s already populated.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {leads.map((lead) => (
        <div
          key={lead.id}
          style={{
            padding: 14,
            border: "1px solid var(--border)",
            borderRadius: 10,
            background: "var(--card)",
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
            <div style={{ fontSize: 13, fontWeight: 500, flex: 1, minWidth: 0 }}>
              {lead.title || "(untitled)"}
            </div>
            <span style={{ fontSize: 11, color: "var(--muted)" }}>
              judge {lead.judge_avg?.toFixed(1) ?? "?"}/10 · edit Δ{lead.draft_edit_distance ?? 0}
            </span>
            {lead.judge_prompt_leak && (
              <span style={{ fontSize: 10.5, padding: "2px 6px", background: "#fef2f2", border: "1px solid #fecaca", color: "#dc2626", borderRadius: 4 }}>
                prompt leak
              </span>
            )}
            <button
              className="btn"
              onClick={() => onReJudge(lead.id)}
              disabled={rejudgeId === lead.id}
              style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12 }}
            >
              <RefreshCw className="h-3 w-3" />
              {rejudgeId === lead.id ? "Judging…" : "Re-judge"}
            </button>
          </div>

          {Array.isArray(lead.edit_reasons) && lead.edit_reasons.length > 0 && (
            <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
              {lead.edit_reasons.map((r) => (
                <span key={r} style={{ fontSize: 10.5, padding: "2px 6px", background: "var(--bg)", border: "1px solid var(--border-light)", borderRadius: 4, color: "var(--fg)" }}>
                  {CATEGORY_LABEL[r] ?? r}
                </span>
              ))}
            </div>
          )}

          {lead.edit_note && (
            <div style={{ fontSize: 12, color: "var(--muted)", fontStyle: "italic", marginBottom: 6 }}>
              &ldquo;{lead.edit_note}&rdquo;
            </div>
          )}

          {Array.isArray(lead.judge_verdicts) && lead.judge_verdicts.length > 0 && (
            <details style={{ fontSize: 12, color: "var(--muted)", marginTop: 6 }}>
              <summary style={{ cursor: "pointer" }}>judge verdicts</summary>
              <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
                {lead.judge_verdicts.map((v) => (
                  <div key={v.judge}>
                    <b>{v.judge}</b> {v.score_0_10}/10 — {v.reasons}
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      ))}
    </div>
  );
}

function StatCard({ label, value, emphasis }: { label: string; value: number; emphasis?: boolean }) {
  return (
    <div className={`rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900 ${emphasis ? "border-zinc-300 dark:border-zinc-700" : ""}`}>
      <div className={`font-medium leading-none ${emphasis ? "text-[34px]" : "text-[28px]"}`}>{value}</div>
      <div className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">{label}</div>
    </div>
  );
}

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-3.5 py-1.5 text-[12px] transition-colors ${
        active
          ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
          : "border-zinc-200 bg-transparent text-zinc-700 hover:border-zinc-300 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-zinc-600"
      }`}
    >
      {children}
    </button>
  );
}

const selectCls = "rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-[12px] text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300";

function PatternCard({
  p, busy, onAccept, onIgnore,
}: {
  p: Pattern;
  busy: boolean;
  onAccept: () => void;
  onIgnore: () => void;
}) {
  // Category accent — maps to Tailwind-safe color names
  const categoryAccent: Record<string, { bg: string; text: string }> = {
    ai_misunderstood: { bg: "bg-red-100 dark:bg-red-950/60", text: "text-red-700 dark:text-red-300" },
    format: { bg: "bg-blue-100 dark:bg-blue-950/60", text: "text-blue-700 dark:text-blue-300" },
    too_verbose: { bg: "bg-amber-100 dark:bg-amber-950/60", text: "text-amber-700 dark:text-amber-300" },
    too_robotic: { bg: "bg-violet-100 dark:bg-violet-950/60", text: "text-violet-700 dark:text-violet-300" },
    individual_taste: { bg: "bg-zinc-100 dark:bg-zinc-800", text: "text-zinc-600 dark:text-zinc-400" },
  };
  const accent = categoryAccent[p.category] ?? { bg: "bg-zinc-100 dark:bg-zinc-800", text: "text-zinc-600 dark:text-zinc-400" };

  return (
    <article className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 border-b border-zinc-100 px-5 py-4 dark:border-zinc-800">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded px-2 py-0.5 text-[11px] font-semibold ${accent.bg} ${accent.text}`}>
            {CATEGORY_LABEL[p.category] ?? p.category}
          </span>
          <span className="text-[12px] text-zinc-500 dark:text-zinc-400">
            seen <strong className="font-semibold text-zinc-800 dark:text-zinc-200">×{p.occurrence_count}</strong>
          </span>
          {p.rep_id !== null && (
            <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
              · {p.rep_name ?? `rep #${p.rep_id}`}
            </span>
          )}
          {p.status !== "pending" && (
            <span
              className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
                p.status === "accepted"
                  ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"
                  : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
              }`}
            >
              {p.status}{p.accepted_by ? ` by ${p.accepted_by}` : ""}
            </span>
          )}
        </div>
        <span className="shrink-0 text-[11px] text-zinc-400 dark:text-zinc-600">
          {new Date(p.detected_at).toLocaleDateString()}
        </span>
      </div>

      {/* Before / after diff */}
      <div className="grid grid-cols-2 gap-3 px-5 py-4">
        <div className="rounded-lg border border-red-100 bg-red-50 p-3 dark:border-red-900/40 dark:bg-red-950/20">
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-red-400 dark:text-red-500">AI wrote</div>
          <p className="text-[13px] leading-relaxed text-red-900 dark:text-red-200 whitespace-pre-wrap break-words">
            {p.ai_phrase}
          </p>
        </div>
        <div className="rounded-lg border border-emerald-100 bg-emerald-50 p-3 dark:border-emerald-900/40 dark:bg-emerald-950/20">
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-500 dark:text-emerald-500">Sales edited to</div>
          <p className="text-[13px] leading-relaxed text-emerald-900 dark:text-emerald-200 whitespace-pre-wrap break-words">
            {p.sales_phrase || "(deleted)"}
          </p>
        </div>
      </div>

      {/* Prompt patch — shown when present, styled as the "what to do about it" */}
      {p.prompt_patch && (
        <div className="border-t border-zinc-100 px-5 py-3 dark:border-zinc-800">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
            Suggested prompt patch
          </div>
          <div
            className="rounded-r-md py-2 pl-3 text-[12px] leading-relaxed text-zinc-700 dark:text-zinc-300"
            style={{
              borderLeft: `2px solid ${
                p.category === "ai_misunderstood" ? "#dc2626"
                : p.category === "too_robotic" ? "#7c3aed"
                : p.category === "format" ? "#2563eb"
                : "#d97706"
              }`,
            }}
          >
            {p.prompt_patch}
          </div>
        </div>
      )}

      {/* Footer — example leads + actions */}
      <div className={`flex items-center justify-between gap-4 px-5 py-3 ${p.prompt_patch ? "" : "border-t border-zinc-100 dark:border-zinc-800"}`}>
        <div className="text-[11px] text-zinc-400 dark:text-zinc-600">
          {Array.isArray(p.example_lead_ids) && p.example_lead_ids.length > 0
            ? `Examples: ${p.example_lead_ids.slice(0, 4).join(", ")}${p.example_lead_ids.length > 4 ? " …" : ""}`
            : "No example leads recorded"}
        </div>
        {p.status === "pending" && (
          <div className="flex items-center gap-2">
            <button
              disabled={busy}
              onClick={onAccept}
              className="inline-flex items-center gap-1.5 rounded-md border border-sky-300 bg-sky-100 px-3 py-1.5 text-[12px] font-medium text-sky-800 hover:bg-sky-200 disabled:opacity-50 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200 dark:hover:bg-sky-900"
            >
              <Check className="h-3.5 w-3.5" /> Accept
            </button>
            <button
              disabled={busy}
              onClick={onIgnore}
              className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 px-3 py-1.5 text-[12px] text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              <X className="h-3.5 w-3.5" /> Ignore
            </button>
          </div>
        )}
      </div>
    </article>
  );
}

/* ===========================================================================
 * Human Signals — raw edit notes + lead correction flags, newest first.
 * This is the qualitative stuff sales writes in their own words that the
 * auto-miner reduces to patterns. Admin reads it directly to sanity-check
 * what the miner claims.
 *
 * Honest empty-state: we explicitly warn when the sample is too thin for
 * any pattern to mean anything — better than implying trends that aren't
 * there.
 * ======================================================================== */

interface HumanSignalsEdit {
  id: string;
  title: string | null;
  edit_reasons: string[] | null;
  edit_note: string | null;
  draft_edit_distance: number | null;
  sent_at: string | null;
  assigned_rep_id: number | null;
  rep_name: string | null;
}

interface HumanSignalsCorrection {
  id: string;
  lead_id: string;
  rep_id: number | null;
  rep_name: string | null;
  type: string;
  reason: string | null;
  severity: string | null;
  skip: boolean | null;
  created_at: string;
}

interface HumanSignalsPayload {
  edits: HumanSignalsEdit[];
  corrections: HumanSignalsCorrection[];
  stats: {
    editsShown: number;
    editsWithNote: number;
    reasonCount: Record<string, number>;
    correctionsShown: number;
    correctionTypeCount: Record<string, number>;
  };
}

// Chinese labels for correction types — kept local so this view doesn't
// reach into FLAG_OPTIONS in ReviewPane (that file's the UI for creating
// flags; this is the reporting view). Duplicate string map is fine at 6 keys.
const CORRECTION_LABEL: Record<string, string> = {
  bad_compute: "Shouldn't need compute",
  wrong_author: "Wrong author",
  wrong_direction: "Wrong direction tag",
  low_quality_email: "Email is poorly written",
  right_lead_wrong_pitch: "Lead is right, pitch is wrong",
  good_lead: "👍 Gut-feel good lead",
};

// Minimum sample size before any aggregate proportion is worth trusting.
// Below this we show the raw list only, no percentages — a "3 of 4 are
// too_verbose" chart is noise, not signal.
const HONEST_SAMPLE_THRESHOLD = 10;

function HumanSignalsView() {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [data, setData] = useState<HumanSignalsPayload | null>(null);
  // Training state — distinct from loading so the Refresh button stays
  // responsive even if the GitHub dispatch is in flight.
  const [training, setTraining] = useState(false);
  const [trainNote, setTrainNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch("/api/drift/human-signals");
      const d = await r.json();
      if (!r.ok) {
        setErr(d.error ?? "Failed to load");
      } else {
        setData(d);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const kickoffTraining = useCallback(async () => {
    setTraining(true);
    setTrainNote(null);
    try {
      const r = await fetch("/api/scorer/train", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoPromote: false }),
      });
      const d = await r.json();
      if (!r.ok) {
        setTrainNote(`❌ ${d.error ?? "failed"}`);
      } else {
        setTrainNote(`✅ ${d.message ?? "training started"} — ${d.workflowUrl ?? ""}`);
      }
    } catch (e) {
      setTrainNote(`❌ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTraining(false);
    }
  }, []);

  if (loading) return <div className="skeleton" style={{ height: 300 }} />;
  if (err) {
    return (
      <div style={{ padding: 16, border: "1px solid #FECACA", background: "#FEF2F2", borderRadius: 8, color: "#991B1B", fontSize: 13 }}>
        {err}
      </div>
    );
  }
  if (!data) return null;

  const { edits, corrections, stats } = data;
  const totalSignals = stats.editsShown + stats.correctionsShown;
  const tooThin = totalSignals < HONEST_SAMPLE_THRESHOLD;

  return (
    <div>
      {/* Counters */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 20 }}>
        <StatCard label="Edits w/ reason tags" value={stats.editsShown} />
        <StatCard label="Edits w/ free-text note" value={stats.editsWithNote} emphasis />
        <StatCard label="Lead corrections" value={stats.correctionsShown} />
        <StatCard label="Total human signals" value={totalSignals} />
      </div>

      {tooThin && (
        <div
          style={{
            padding: "12px 14px",
            border: "1px solid #FDE68A",
            background: "#FFFBEB",
            borderRadius: 8,
            fontSize: 12.5,
            color: "#92400E",
            marginBottom: 20,
            lineHeight: 1.55,
          }}
        >
          <strong>Sample still too small ({totalSignals})</strong>
          &nbsp;—&nbsp; below {HONEST_SAMPLE_THRESHOLD} signals nothing here is statistically meaningful. Read the list as raw signal, but don&apos;t patch prompts from it yet. Wait until you have {HONEST_SAMPLE_THRESHOLD}+ before running the miner.
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 12, flexWrap: "wrap" }}>
        {/* Training status note — shown inline so admin sees the workflow URL
            without chasing a toast. Empty string rendered as nothing. */}
        <div style={{ fontSize: 11.5, color: "var(--muted)", flex: 1, minWidth: 0, wordBreak: "break-word" }}>
          {trainNote}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => refresh()}
            style={{ fontSize: 12, padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--card)", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 }}
          >
            <RefreshCw style={{ width: 12, height: 12 }} /> Refresh
          </button>
          {/* Gated on sample size — training on <10 signals overfits and
              blows budget on the GH runner. Tooltip explains the block. */}
          <button
            onClick={kickoffTraining}
            disabled={tooThin || training}
            title={tooThin
              ? `Sample too small (${totalSignals}/${HONEST_SAMPLE_THRESHOLD}) — wait for ${HONEST_SAMPLE_THRESHOLD - totalSignals} more human signals before training.`
              : "Dispatch a new scorer training run on GitHub Actions. 3-8 min."}
            style={{
              fontSize: 12,
              padding: "6px 12px",
              border: "1px solid " + (tooThin ? "var(--border)" : "#6366F1"),
              borderRadius: 6,
              background: tooThin || training ? "var(--card)" : "#6366F1",
              color: tooThin || training ? "var(--muted)" : "white",
              cursor: tooThin || training ? "not-allowed" : "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              opacity: tooThin ? 0.6 : 1,
            }}
          >
            {training ? <Loader2 style={{ width: 12, height: 12 }} className="spin" /> : <Zap style={{ width: 12, height: 12 }} />}
            {training ? "Dispatching…" : "Train new model"}
          </button>
        </div>
      </div>

      {/* Reason-tag frequencies — only shown when sample is large enough. */}
      {!tooThin && Object.keys(stats.reasonCount).length > 0 && (
        <Section title="Edit reasons (checkbox tags)">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {Object.entries(stats.reasonCount)
              .sort((a, b) => b[1] - a[1])
              .map(([reason, n]) => (
                <span
                  key={reason}
                  style={{
                    padding: "4px 10px",
                    fontSize: 12,
                    border: "1px solid var(--border)",
                    borderRadius: 999,
                    background: "var(--card)",
                    color: CATEGORY_COLOR[reason] ?? "var(--fg)",
                  }}
                >
                  {CATEGORY_LABEL[reason] ?? reason} · {n}
                </span>
              ))}
          </div>
        </Section>
      )}

      {!tooThin && Object.keys(stats.correctionTypeCount).length > 0 && (
        <Section title="Correction flags (by type)">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {Object.entries(stats.correctionTypeCount)
              .sort((a, b) => b[1] - a[1])
              .map(([type, n]) => (
                <span
                  key={type}
                  style={{
                    padding: "4px 10px",
                    fontSize: 12,
                    border: "1px solid var(--border)",
                    borderRadius: 999,
                    background: "var(--card)",
                  }}
                >
                  {CORRECTION_LABEL[type] ?? type} · {n}
                </span>
              ))}
          </div>
        </Section>
      )}

      {/* Raw edit notes — the highest-signal qualitative stuff. Always
          rendered (even below the threshold) because a single good note
          is worth reading, even if we can't aggregate it. */}
      <Section title={`Edit notes (${edits.length})`}>
        {edits.length === 0 ? (
          <EmptyHint text="No sales edits yet. When sales edits subject/body in Review and presses Send, rows with reasons + optional notes will appear here." />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {edits.map((e) => (
              <EditRow key={e.id} edit={e} />
            ))}
          </div>
        )}
      </Section>

      <Section title={`Correction flags (${corrections.length})`}>
        {corrections.length === 0 ? (
          <EmptyHint text="No sales flags yet. When sales hits 🚩 Flag in Review (wrong author / direction / pitch / etc.), the record will appear here." />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {corrections.map((c) => (
              <CorrectionRow key={c.id} correction={c} />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, color: "var(--fg)" }}>{title}</h3>
      {children}
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div style={{ padding: "16px 14px", border: "1px dashed var(--border)", borderRadius: 8, color: "var(--muted)", fontSize: 12.5, lineHeight: 1.6 }}>
      {text}
    </div>
  );
}

function EditRow({ edit }: { edit: HumanSignalsEdit }) {
  const sentAt = edit.sent_at ? new Date(edit.sent_at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
  return (
    <div style={{ padding: 12, border: "1px solid var(--border)", borderRadius: 8, background: "var(--card)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, color: "var(--muted)" }}>{sentAt}</span>
        {edit.assigned_rep_id !== null && (
          <span style={{ fontSize: 11, color: "var(--muted)" }}>· {edit.rep_name ?? `rep #${edit.assigned_rep_id}`}</span>
        )}
        {edit.draft_edit_distance !== null && (
          <span style={{ fontSize: 11, color: "var(--muted)" }}>· {edit.draft_edit_distance} chars edit distance</span>
        )}
        {(edit.edit_reasons ?? []).map((r) => (
          <span
            key={r}
            style={{
              fontSize: 10,
              padding: "2px 7px",
              borderRadius: 999,
              background: (CATEGORY_COLOR[r] ?? "#6b7280") + "1a",
              color: CATEGORY_COLOR[r] ?? "#6b7280",
              fontWeight: 600,
            }}
          >
            {CATEGORY_LABEL[r] ?? r}
          </span>
        ))}
      </div>
      {edit.title && (
        <div style={{ fontSize: 12.5, fontWeight: 500, color: "var(--fg)", marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={edit.title}>
          {edit.title}
        </div>
      )}
      {edit.edit_note ? (
        <div style={{ fontSize: 13, color: "var(--fg)", whiteSpace: "pre-wrap", wordBreak: "break-word", padding: "6px 10px", background: "var(--bg, #F9FAFB)", borderRadius: 6, borderLeft: "3px solid #6366F1" }}>
          &ldquo;{edit.edit_note}&rdquo;
        </div>
      ) : (
        <div style={{ fontSize: 11, color: "var(--muted)", fontStyle: "italic" }}>(no free-text note)</div>
      )}
    </div>
  );
}

function CorrectionRow({ correction }: { correction: HumanSignalsCorrection }) {
  const createdAt = new Date(correction.created_at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const isHard = correction.severity === "hard";
  return (
    <div style={{
      padding: 12,
      border: "1px solid " + (isHard ? "#FCA5A5" : "var(--border)"),
      borderRadius: 8,
      background: isHard ? "#FEF2F2" : "var(--card)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, color: "var(--muted)" }}>{createdAt}</span>
        {correction.rep_id !== null && (
          <span style={{ fontSize: 11, color: "var(--muted)" }}>· {correction.rep_name ?? `rep #${correction.rep_id}`}</span>
        )}
        <span style={{
          fontSize: 10, padding: "2px 7px", borderRadius: 999,
          background: isHard ? "#DC2626" : "var(--border)",
          color: isHard ? "white" : "var(--fg)",
          fontWeight: 600,
        }}>
          {CORRECTION_LABEL[correction.type] ?? correction.type}
        </span>
        {isHard && <span style={{ fontSize: 10, color: "#DC2626", fontWeight: 600 }}>HARD · blocklisted</span>}
        {correction.skip && <span style={{ fontSize: 10, color: "var(--muted)" }}>· also skip</span>}
      </div>
      <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 4 }}>lead {correction.lead_id.slice(0, 8)}</div>
      {correction.reason ? (
        <div style={{ fontSize: 13, color: "var(--fg)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {correction.reason}
        </div>
      ) : (
        <div style={{ fontSize: 11, color: "var(--muted)", fontStyle: "italic" }}>(no reason provided)</div>
      )}
    </div>
  );
}
