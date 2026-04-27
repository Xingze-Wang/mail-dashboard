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
  ai_misunderstood: "AI 理解错",
  format: "格式",
  too_verbose: "啰嗦",
  too_robotic: "AI腔",
  individual_taste: "个人偏好",
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
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h1 className="page-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Activity className="h-6 w-6" />
            Drift
          </h1>
          <p style={{ color: "var(--muted)", marginTop: 6, fontSize: 13 }}>
            Patterns mined from sales edits. Accepted patterns are appended to <code>pipeline_intro_prompt</code>.
          </p>
          <p style={{ color: "var(--muted)", marginTop: 4, fontSize: 12 }}>
            last mined at: {lastMinedAt ? new Date(lastMinedAt).toLocaleString() : "never run"}
          </p>
        </div>
        {tab === "patterns" && (
          <button
            className="btn primary"
            onClick={runMiner}
            disabled={mining}
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <Play className="h-4 w-4" />
            {mining ? "Mining…" : "Run miner (90d)"}
          </button>
        )}
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 8, marginBottom: 20, borderBottom: "1px solid var(--border)" }}>
        <TabButton active={tab === "patterns"} onClick={() => setTab("patterns")}>
          <AlertTriangle className="h-4 w-4" /> Patterns
        </TabButton>
        <TabButton active={tab === "disagreement"} onClick={() => setTab("disagreement")}>
          <Scale className="h-4 w-4" /> Judge vs Human
        </TabButton>
        <TabButton active={tab === "human"} onClick={() => setTab("human")}>
          <MessageSquare className="h-4 w-4" /> Human Signals
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
        <div
          style={{
            padding: "12px 14px",
            border: "1px solid #FDE68A",
            background: "#FFFBEB",
            borderRadius: 8,
            fontSize: 13,
            color: "#92400E",
            marginBottom: 16,
            lineHeight: 1.55,
          }}
        >
          ⚠ {setupHint}
        </div>
      )}

      {mineNote && (
        <div
          style={{
            padding: "10px 14px",
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--card)",
            marginBottom: 16,
            fontSize: 13,
          }}
        >
          {mineNote}
        </div>
      )}

      {/* Stat row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 24 }}>
        <StatCard label="Total mined" value={counts.total} />
        <StatCard label="Pending review" value={counts.pending} emphasis />
        <StatCard label="Accepted" value={counts.accepted} />
        <StatCard label="Ignored" value={counts.ignored} />
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        <Pill active={statusFilter === "pending"} onClick={() => setStatusFilter("pending")}>Pending ({counts.pending})</Pill>
        <Pill active={statusFilter === "accepted"} onClick={() => setStatusFilter("accepted")}>Accepted ({counts.accepted})</Pill>
        <Pill active={statusFilter === "ignored"} onClick={() => setStatusFilter("ignored")}>Ignored ({counts.ignored})</Pill>
        <Pill active={statusFilter === "all"} onClick={() => setStatusFilter("all")}>All ({counts.total})</Pill>

        <div style={{ width: 1, height: 18, background: "var(--border)", margin: "0 4px" }} />

        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          style={selectStyle}
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
          style={selectStyle}
        >
          <option value="all">All reps</option>
          <option value="global">Global only</option>
          <option value="1">Leo (1)</option>
          <option value="2">Chenyu (2)</option>
          <option value="3">Ethan (3)</option>
        </select>
      </div>

      {/* Pattern list */}
      {loading ? (
        <div className="skeleton" style={{ height: 200 }} />
      ) : patterns.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">
            <AlertTriangle style={{ width: 22, height: 22 }} />
          </div>
          <h3>No mined patterns yet</h3>
          <p>The LLM miner needs ≥3 edited drafts (with edit_reasons or notes) within the lookback window to detect a pattern. At the team's current edit volume that threshold often isn't met — but the raw qualitative signal is still there.</p>
          <p style={{ marginTop: 8 }}>
            <button className="btn" onClick={onSwitchToHuman} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <MessageSquare className="h-4 w-4" /> See raw human signals →
            </button>
            {" "}— every edit reason, edit note, and lead-correction the team has logged, even when there's not enough volume to mine a pattern.
          </p>
          <p style={{ marginTop: 8, fontSize: 12, color: "var(--text-tertiary)" }}>You can also click <b>Run miner</b> above to force a fresh pass.</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
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
      style={{
        padding: "8px 14px",
        fontSize: 13,
        fontWeight: active ? 600 : 400,
        background: "transparent",
        border: "none",
        borderBottom: "2px solid " + (active ? "var(--fg)" : "transparent"),
        color: active ? "var(--fg)" : "var(--muted)",
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        marginBottom: -1,
      }}
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
    <div
      className="stat-card"
      style={emphasis ? { background: "linear-gradient(180deg, var(--card) 0%, var(--bg) 100%)", borderColor: "rgba(10,10,10,0.12)" } : undefined}
    >
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={emphasis ? { fontSize: 34 } : undefined}>{value}</div>
    </div>
  );
}

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "6px 14px",
        fontSize: 12.5,
        borderRadius: 999,
        border: "1px solid " + (active ? "var(--fg)" : "var(--border)"),
        background: active ? "var(--fg)" : "transparent",
        color: active ? "var(--bg)" : "var(--fg)",
        cursor: "pointer",
        transition: "all 120ms",
      }}
    >
      {children}
    </button>
  );
}

const selectStyle: React.CSSProperties = {
  padding: "6px 10px",
  fontSize: 12.5,
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--card)",
  color: "var(--fg)",
};

function PatternCard({
  p, busy, onAccept, onIgnore,
}: {
  p: Pattern;
  busy: boolean;
  onAccept: () => void;
  onIgnore: () => void;
}) {
  const color = CATEGORY_COLOR[p.category] ?? "#6b7280";
  return (
    <div
      style={{
        padding: 16,
        border: "1px solid var(--border)",
        borderRadius: 10,
        background: "var(--card)",
        display: "grid",
        gridTemplateColumns: "1fr auto",
        gap: 16,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
          <span
            style={{
              padding: "2px 8px",
              borderRadius: 4,
              fontSize: 11,
              fontWeight: 600,
              background: color + "22",
              color,
            }}
          >
            {CATEGORY_LABEL[p.category] ?? p.category}
          </span>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>×{p.occurrence_count}</span>
          {p.rep_id !== null && (
            <span style={{ fontSize: 11, color: "var(--muted)" }}>· {p.rep_name ?? `rep #${p.rep_id}`}</span>
          )}
          {p.status !== "pending" && (
            <span
              style={{
                fontSize: 11,
                padding: "2px 6px",
                borderRadius: 4,
                background: p.status === "accepted" ? "#16a34a22" : "#6b728022",
                color: p.status === "accepted" ? "#16a34a" : "#6b7280",
              }}
            >
              {p.status}
              {p.accepted_by ? ` by ${p.accepted_by}` : ""}
            </span>
          )}
          <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--muted)" }}>
            {new Date(p.detected_at).toLocaleDateString()}
          </span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 8 }}>
          <DiffCol label="AI 写的" body={p.ai_phrase} bg="#fef2f2" border="#fecaca" />
          <DiffCol label="Sales 改成" body={p.sales_phrase || "(删除)"} bg="#f0fdf4" border="#bbf7d0" />
        </div>

        {p.prompt_patch && (
          <div
            style={{
              marginTop: 6,
              padding: "8px 10px",
              borderLeft: "3px solid " + color,
              background: "var(--bg)",
              fontSize: 12,
              color: "var(--fg)",
              borderRadius: "0 6px 6px 0",
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 2, color: "var(--muted)", fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.4 }}>
              Suggested patch
            </div>
            {p.prompt_patch}
          </div>
        )}

        {Array.isArray(p.example_lead_ids) && p.example_lead_ids.length > 0 && (
          <div style={{ marginTop: 8, fontSize: 11, color: "var(--muted)" }}>
            examples: {p.example_lead_ids.slice(0, 5).join(", ")}
          </div>
        )}
      </div>

      {p.status === "pending" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, alignSelf: "center" }}>
          <button
            className="btn primary"
            disabled={busy}
            onClick={onAccept}
            style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
          >
            <Check className="h-4 w-4" /> Accept
          </button>
          <button
            className="btn"
            disabled={busy}
            onClick={onIgnore}
            style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
          >
            <X className="h-4 w-4" /> Ignore
          </button>
        </div>
      )}
    </div>
  );
}

function DiffCol({ label, body, bg, border }: { label: string; body: string; bg: string; border: string }) {
  return (
    <div
      style={{
        padding: 10,
        background: bg,
        border: "1px solid " + border,
        borderRadius: 6,
      }}
    >
      <div style={{ fontSize: 10.5, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 13, color: "#1A1A1A", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {body}
      </div>
    </div>
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
  bad_compute: "不该需要算力",
  wrong_author: "作者搞错",
  wrong_direction: "方向标错",
  low_quality_email: "Email 写得不好",
  right_lead_wrong_pitch: "Lead 对, 话术不对",
  good_lead: "👍 直觉好 lead",
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
          <strong>样本还太少 ({totalSignals}&nbsp;条)</strong>
          &nbsp;—&nbsp; 低于 {HONEST_SAMPLE_THRESHOLD} 条没法得出稳定结论。下面的列表可以当原始信号看，但不要据此给 prompt 打补丁。累计到 {HONEST_SAMPLE_THRESHOLD}+ 条之后再跑 miner。
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
              ? `样本太少 (${totalSignals}/${HONEST_SAMPLE_THRESHOLD}) — 再等 ${HONEST_SAMPLE_THRESHOLD - totalSignals} 条人类信号再 train。`
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
          <EmptyHint text="还没有 sales 改过草稿。当 sales 在 Review 里编辑 subject/body 再按 Send, 这里会出现带 reasons + 可选 note 的行。" />
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
          <EmptyHint text="还没有 sales 在 Review 里点过 🚩 Flag。当 sales 觉得 lead 有问题 (作者错/方向错/话术不对/etc.) 按那个按钮, 这里会出现记录。" />
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
          <span style={{ fontSize: 11, color: "var(--muted)" }}>· {edit.draft_edit_distance}字 edit distance</span>
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
        {isHard && <span style={{ fontSize: 10, color: "#DC2626", fontWeight: 600 }}>HARD · 已拉黑</span>}
        {correction.skip && <span style={{ fontSize: 10, color: "var(--muted)" }}>· 同时 skip</span>}
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
