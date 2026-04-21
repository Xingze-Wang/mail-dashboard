"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Activity, Play, Check, X, AlertTriangle, Scale, RefreshCw } from "lucide-react";

type Tab = "patterns" | "disagreement";

interface Pattern {
  id: string;
  detected_at: string;
  rep_id: number | null;
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
    } finally {
      setLoading(false);
    }
  }, [statusFilter, categoryFilter, repFilter]);

  useEffect(() => {
    if (gated !== "allowed") return;
    reload();
  }, [gated, reload]);

  async function runMiner() {
    setMining(true);
    setMineNote(null);
    try {
      const r = await fetch("/api/drift/mine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days: 30 }),
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
        </div>
        {tab === "patterns" && (
          <button
            className="btn primary"
            onClick={runMiner}
            disabled={mining}
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <Play className="h-4 w-4" />
            {mining ? "Mining…" : "Run miner (30d)"}
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
      </div>

      {tab === "disagreement" && <DisagreementView />}
      {tab === "patterns" && <PatternsView
        mineNote={mineNote}
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
      />}
    </div>
  );
}

/* === Patterns view (extracted so Judge-vs-Human can live alongside) === */
function PatternsView(props: {
  mineNote: string | null;
  counts: Counts;
  byCategory: Record<string, number>;
  statusFilter: "pending" | "accepted" | "ignored" | "all";
  setStatusFilter: (s: "pending" | "accepted" | "ignored" | "all") => void;
  categoryFilter: string;
  setCategoryFilter: (s: string) => void;
  repFilter: string;
  setRepFilter: (s: string) => void;
  loading: boolean;
  patterns: Pattern[];
  actingId: string | null;
  actOn: (id: string, action: "accept" | "ignore") => void;
}) {
  const { mineNote, counts, byCategory, statusFilter, setStatusFilter, categoryFilter, setCategoryFilter, repFilter, setRepFilter, loading, patterns, actingId, actOn } = props;
  return (
    <div>

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
          <h3>No patterns match these filters</h3>
          <p>Run the miner to scan recent sales edits, or loosen the filters above.</p>
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
    return <div style={{ padding: 20, color: "var(--muted)", textAlign: "center", fontSize: 13 }}>No leads in this quadrant.</div>;
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
            <span style={{ fontSize: 11, color: "var(--muted)" }}>· rep {p.rep_id}</span>
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
