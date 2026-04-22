// Extracted tab components for /scorer — keeps page.tsx focused on the
// established Lead-quality view. Each tab fetches its own endpoint lazily.
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BarChart, Bar, LineChart, Line,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import { Sparkles, Target, Users2, Play, Loader2, AlertTriangle, TrendingUp, Cpu, FileEdit, Save, RotateCcw, Zap } from "lucide-react";

const TOOLTIP = {
  backgroundColor: "#FFFFFF",
  border: "1px solid var(--border)",
  borderRadius: 8,
  fontSize: 12,
  color: "#1A1A1A",
  boxShadow: "0 4px 12px rgba(0,0,0,0.06)",
};

/* ========== Email Quality ========== */

interface EmailQualityData {
  totalJudged: number;
  meanScore: number;
  leakRate: number;
  byJudge: { judge: string; meanScore: number; leakRate: number; n: number }[];
  weeks: { week: string; meanScore: number; leakRate: number; n: number }[];
  distribution: { bin: string; count: number }[];
  agreement: { jLovedSHated: number; jHatedSKept: number; bothLoved: number; bothHated: number; middle: number };
  unjudged: number;
}

export function EmailQualityTab() {
  const [data, setData] = useState<EmailQualityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [judging, setJudging] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/scorer/email-quality", { cache: "no-store" });
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

  async function runJudge() {
    setJudging(true);
    setNote(null);
    try {
      const r = await fetch("/api/scorer/email-quality", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sampleSize: 10 }),
      });
      const d = await r.json();
      if (!r.ok) setNote(`❌ ${d.error}`);
      else if (d.reason) setNote(`ℹ ${d.reason}`);
      else {
        setNote(`✓ judged ${d.judged} new draft(s) (${d.errored} errored)`);
        await reload();
      }
    } catch (e) {
      setNote(`❌ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setJudging(false);
    }
  }

  if (loading) return <div className="skeleton" style={{ height: 300 }} />;
  if (err) return <Empty title="Error" body={err} />;
  if (!data || data.totalJudged === 0) {
    return (
      <div>
        <Empty
          title="No judged drafts yet"
          body="Judge recent sent drafts to populate this view. Each run judges up to 10 drafts through the Opus + Gemini + GPT-5 ensemble."
        />
        <div style={{ textAlign: "center", marginTop: 16 }}>
          <button className="btn btn-primary" onClick={runJudge} disabled={judging}>
            {judging ? <Loader2 style={{ width: 14, height: 14 }} className="spin" /> : <Play style={{ width: 14, height: 14 }} />}
            {judging ? "Judging…" : `Judge 10 drafts (${data?.unjudged ?? 0} backlog)`}
          </button>
        </div>
        {note && <div style={noteBar}>{note}</div>}
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, gap: 10 }}>
        <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
          {data.totalJudged} drafts judged · {data.unjudged} unjudged in queue
        </div>
        <button className="btn" onClick={runJudge} disabled={judging} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {judging ? <Loader2 style={{ width: 14, height: 14 }} className="spin" /> : <Play style={{ width: 14, height: 14 }} />}
          {judging ? "Judging…" : "Judge next 10"}
        </button>
      </div>
      {note && <div style={noteBar}>{note}</div>}

      <RubricEditor />


      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginBottom: 20 }}>
        <Stat label="Mean score (0-10)" value={data.meanScore.toFixed(1)} emphasis />
        <Stat label="Prompt-leak rate" value={`${data.leakRate}%`} tone={data.leakRate > 5 ? "alert" : "ok"} />
        <Stat label="Judges run" value={`${data.byJudge.length}`} sub={data.byJudge.map(j => j.judge.split("-")[0]).join(" · ")} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 16, marginBottom: 20 }}>
        <div className="section-card">
          <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
            <TrendingUp style={{ width: 14, height: 14 }} />
            Mean score over time
          </h3>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={data.weeks}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" />
              <XAxis dataKey="week" tick={{ fontSize: 10, fill: "var(--text-tertiary)" }} />
              <YAxis domain={[0, 10]} tick={{ fontSize: 10, fill: "var(--text-tertiary)" }} />
              <Tooltip contentStyle={TOOLTIP} />
              <Line type="monotone" dataKey="meanScore" stroke="#3B82F6" strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="section-card">
          <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Per-judge consensus</h3>
          <table style={{ width: "100%", fontSize: 12 }}>
            <thead>
              <tr style={{ color: "var(--text-tertiary)" }}>
                <th style={{ textAlign: "left", padding: "4px 0" }}>Judge</th>
                <th style={{ textAlign: "right" }}>Mean</th>
                <th style={{ textAlign: "right" }}>Leak %</th>
              </tr>
            </thead>
            <tbody>
              {data.byJudge.map((j) => (
                <tr key={j.judge} style={{ borderTop: "1px solid var(--border-light)" }}>
                  <td style={{ padding: "6px 0" }}>{j.judge}</td>
                  <td style={{ textAlign: "right", fontWeight: 500 }}>{j.meanScore}</td>
                  <td style={{ textAlign: "right", color: j.leakRate > 5 ? "#dc2626" : "var(--text)" }}>{j.leakRate}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="section-card" style={{ marginBottom: 20 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Judge vs Sales agreement</h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, fontSize: 12 }}>
          <Agreement label="Judges loved, sales hated" count={data.agreement.jLovedSHated} tone="alert" hint="rubric blind spot" />
          <Agreement label="Judges hated, sales kept" count={data.agreement.jHatedSKept} tone="alert" hint="rubric too harsh" />
          <Agreement label="Both loved" count={data.agreement.bothLoved} tone="ok" hint="working" />
          <Agreement label="Both hated" count={data.agreement.bothHated} tone="ok" hint="AI genuinely weak" />
        </div>
        <p style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 10 }}>
          Detailed per-lead breakdown in the <a href="/drift" style={{ color: "var(--blue)" }}>Drift → Judge vs Human</a> tab.
        </p>
      </div>
    </div>
  );
}

/* ========== Conversion ========== */

interface ConvBucket { bucket: string; sent: number; converted: number; rate: number; lift: number }
interface ConversionData {
  baseline: number;
  totalSent: number;
  totalConverted: number;
  withLeadData?: number;
  coverage?: number;
  byScore: ConvBucket[];
  byTier: ConvBucket[];
  byCitations: ConvBucket[];
  bySchoolTier: ConvBucket[];
  byRep: ConvBucket[];
  byDirection: ConvBucket[];
  byDomain?: ConvBucket[];
  byDay: ConvBucket[];
  topLift: (ConvBucket & { feature: string })[];
}

export function ConversionTab() {
  const [data, setData] = useState<ConversionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/scorer/conversion", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => { if (d.error) setErr(d.error); else setData(d); })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="skeleton" style={{ height: 300 }} />;
  if (err) return <Empty title="Error" body={err} />;
  if (!data || data.totalSent === 0) return <Empty title="No sent leads yet" body="Send some leads and mark WeChat conversions first." />;

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr 1fr 1fr", gap: 12, marginBottom: 20 }}>
        <TechMetric label="Baseline conv rate" value={`${data.baseline}%`} sub={`${data.totalConverted} / ${data.totalSent}`} accent />
        <TechMetric label="Total sent" value={data.totalSent.toLocaleString()} sub="unique recipients" />
        <TechMetric label="WeChat adds" value={data.totalConverted.toLocaleString()} />
        <TechMetric
          label="Lead-data coverage"
          value={typeof data.coverage === "number" ? `${data.coverage}%` : "—"}
          sub={typeof data.withLeadData === "number" ? `${data.withLeadData.toLocaleString()} with features` : undefined}
          tone={typeof data.coverage === "number" && data.coverage < 30 ? "alert" : undefined}
        />
      </div>

      {data.topLift.length > 0 && (
        <div className="section-card" style={{ marginBottom: 20 }}>
          <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Features that move conversion most</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {data.topLift.map((b, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12, padding: "6px 8px", background: "var(--bg)", borderRadius: 4 }}>
                <div>
                  <span style={{ color: "var(--text-tertiary)", marginRight: 8 }}>{b.feature}</span>
                  <span style={{ fontWeight: 500 }}>{b.bucket}</span>
                </div>
                <div style={{ fontSize: 11, color: b.lift > 1 ? "#16a34a" : "#dc2626", fontWeight: 500 }}>
                  {b.lift > 1 ? `+${Math.round((b.lift - 1) * 100)}%` : `${Math.round((b.lift - 1) * 100)}%`} vs baseline
                  <span style={{ marginLeft: 8, color: "var(--text-tertiary)" }}>({b.converted}/{b.sent})</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <ConversionTrainer />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <BucketTable title="By email domain" buckets={data.byDomain ?? []} baseline={data.baseline} />
        <BucketTable title="By rep" buckets={data.byRep} baseline={data.baseline} />
        <BucketTable title="By score" buckets={data.byScore} baseline={data.baseline} />
        <BucketTable title="By tier" buckets={data.byTier} baseline={data.baseline} />
        <BucketTable title="By citations" buckets={data.byCitations} baseline={data.baseline} />
        <BucketTable title="By school tier" buckets={data.bySchoolTier} baseline={data.baseline} />
        <BucketTable title="By day sent" buckets={data.byDay} baseline={data.baseline} />
      </div>
    </div>
  );
}

function BucketTable({ title, buckets, baseline }: { title: string; buckets: ConvBucket[]; baseline: number }) {
  if (buckets.length === 0) return null;
  return (
    <div className="section-card">
      <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>{title}</h3>
      <table style={{ width: "100%", fontSize: 12 }}>
        <thead>
          <tr style={{ color: "var(--text-tertiary)" }}>
            <th style={{ textAlign: "left", padding: "4px 0" }}>Bucket</th>
            <th style={{ textAlign: "right" }}>Sent</th>
            <th style={{ textAlign: "right" }}>Conv</th>
            <th style={{ textAlign: "right" }}>Rate</th>
          </tr>
        </thead>
        <tbody>
          {buckets.map((b) => {
            const diff = baseline > 0 ? b.rate - baseline : 0;
            return (
              <tr key={b.bucket} style={{ borderTop: "1px solid var(--border-light)" }}>
                <td style={{ padding: "5px 0" }}>{b.bucket}</td>
                <td style={{ textAlign: "right" }}>{b.sent}</td>
                <td style={{ textAlign: "right" }}>{b.converted}</td>
                <td style={{ textAlign: "right", fontWeight: 500, color: diff > 5 ? "#16a34a" : diff < -5 ? "#dc2626" : "var(--text)" }}>
                  {b.rate}%
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ========== Match ========== */

interface MatchData {
  totalSent: number;
  byRep: { repId: number; repName: string; sent: number; converted: number; convRate: number; meanLeadScore: number }[];
  ruleCounts: Record<string, number>;
  misrouted: number;
  strongCriteria: { min_citation: number; min_citation_unverified: number; max_school_tier: number; min_local_score: number };
}

export function MatchTab() {
  const [data, setData] = useState<MatchData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/scorer/match", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => { if (d.error) setErr(d.error); else setData(d); })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="skeleton" style={{ height: 300 }} />;
  if (err) return <Empty title="Error" body={err} />;
  if (!data || data.totalSent === 0) return <Empty title="No sent leads yet" body="Match scorer needs sent-lead data to audit." />;

  const crit = data.strongCriteria;
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginBottom: 20 }}>
        <Stat label="Total sent" value={data.totalSent.toString()} />
        <Stat
          label="Mis-routed (config drift)"
          value={data.misrouted.toString()}
          sub={`${Math.round((data.misrouted / data.totalSent) * 1000) / 10}% of total`}
          tone={data.misrouted > data.totalSent * 0.1 ? "alert" : "ok"}
        />
        <Stat label="Active reps" value={data.byRep.length.toString()} />
      </div>

      <div className="section-card" style={{ marginBottom: 20 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Per-rep performance</h3>
        <table style={{ width: "100%", fontSize: 12 }}>
          <thead>
            <tr style={{ color: "var(--text-tertiary)" }}>
              <th style={{ textAlign: "left", padding: "4px 0" }}>Rep</th>
              <th style={{ textAlign: "right" }}>Sent</th>
              <th style={{ textAlign: "right" }}>Conv</th>
              <th style={{ textAlign: "right" }}>Conv %</th>
              <th style={{ textAlign: "right" }}>Mean lead score</th>
            </tr>
          </thead>
          <tbody>
            {data.byRep.map((r) => (
              <tr key={r.repId} style={{ borderTop: "1px solid var(--border-light)" }}>
                <td style={{ padding: "6px 0", fontWeight: 500 }}>{r.repName}</td>
                <td style={{ textAlign: "right" }}>{r.sent}</td>
                <td style={{ textAlign: "right" }}>{r.converted}</td>
                <td style={{ textAlign: "right", fontWeight: 500 }}>{r.convRate}%</td>
                <td style={{ textAlign: "right", color: "var(--text-tertiary)" }}>{r.meanLeadScore.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div className="section-card">
          <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Routing rule distribution</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {Object.entries(data.ruleCounts).map(([rule, count]) => (
              <div key={rule} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12 }}>
                <span style={{ color: "var(--text-secondary)" }}>{rule}</span>
                <span style={{ fontWeight: 500 }}>{count}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="section-card">
          <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Strong-tier thresholds</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
            <KV k="Min citation (school verified)" v={crit.min_citation.toLocaleString()} />
            <KV k="Min citation (school unknown)" v={crit.min_citation_unverified.toLocaleString()} />
            <KV k="Max school tier for strong" v={`≤ ${crit.max_school_tier}`} />
            <KV k="Min local score for strong" v={crit.min_local_score.toFixed(2)} />
          </div>
        </div>
      </div>

      <RulesConsole />
    </div>
  );
}

/* ========== shared ========== */

export function TechMetric({
  label, value, sub, accent, tone,
}: {
  label: string; value: string; sub?: string; accent?: boolean; tone?: "ok" | "alert"
}) {
  return (
    <div className="metric-tech">
      {accent && <div className="accent-bar" />}
      <div className="metric-label">{label}</div>
      <div
        className={"metric-value" + (accent ? " gradient" : "")}
        style={tone === "alert" ? { color: "#dc2626" } : tone === "ok" ? { color: "#16a34a" } : undefined}
      >
        {value}
      </div>
      {sub && <div className="metric-sub">{sub}</div>}
    </div>
  );
}

// Back-compat alias — some callers still import `Stat`.
function Stat(props: { label: string; value: string; sub?: string; emphasis?: boolean; tone?: "ok" | "alert" }) {
  return <TechMetric label={props.label} value={props.value} sub={props.sub} accent={props.emphasis} tone={props.tone} />;
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <AlertTriangle style={{ width: 22, height: 22 }} />
      </div>
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px dashed var(--border-light)" }}>
      <span style={{ color: "var(--text-tertiary)" }}>{k}</span>
      <span style={{ fontWeight: 500 }}>{v}</span>
    </div>
  );
}

function Agreement({ label, count, tone, hint }: { label: string; count: number; tone: "ok" | "alert"; hint: string }) {
  const accent = tone === "alert" ? "#dc2626" : "#16a34a";
  return (
    <div style={{ padding: 10, border: "1px solid var(--border-light)", borderRadius: 6 }}>
      <div style={{ fontSize: 10.5, color: "var(--text-tertiary)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, color: accent, lineHeight: 1.1 }}>{count}</div>
      <div style={{ fontSize: 10.5, color: accent, marginTop: 4 }}>{hint}</div>
    </div>
  );
}

const noteBar: React.CSSProperties = {
  padding: "10px 14px",
  border: "1px solid var(--border)",
  borderRadius: 8,
  background: "var(--card)",
  margin: "16px 0",
  fontSize: 13,
};

/* ================================================================
 * Workbench components — each scorer tab has an admin-editing panel.
 * ================================================================ */

/* ── Lead quality: train + promote workbench ─────────────────────── */

interface RunRow {
  id?: string;
  trained_at: string;
  n_samples: number;
  cv_f1: number;
  cv_auc: number;
  cv_precision: number;
  cv_recall: number;
  embedder: string;
}

export function LeadTrainWorkbench() {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [active, setActive] = useState<{ id: string; promoted_at?: string; promoted_by?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [training, setTraining] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [autoPromote, setAutoPromote] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [rRuns, rActive] = await Promise.all([
        fetch("/api/scorer", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/scorer/promote", { cache: "no-store" }).then((r) => r.json()).catch(() => ({ active: null })),
      ]);
      setRuns(rRuns.history ?? []);
      setActive(rActive.active ?? null);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  async function train() {
    setTraining(true);
    setNote(null);
    try {
      const r = await fetch("/api/scorer/train", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoPromote }),
      });
      const d = await r.json();
      if (!r.ok) setNote(`❌ ${d.error ?? "train failed"}`);
      else setNote(`✓ Training started. Watch progress: ${d.workflowUrl}`);
    } catch (e) {
      setNote(`❌ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTraining(false);
    }
  }

  async function promote(runId: string | undefined) {
    if (!runId) return;
    const r = await fetch("/api/scorer/promote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId }),
    });
    const d = await r.json();
    if (!r.ok) alert(d.error ?? "promote failed");
    else { setNote(`✓ Promoted ${runId.slice(0, 8)}`); reload(); }
  }

  return (
    <div className="tech-card" style={{ marginTop: 20 }}>
      <div className="tech-header">
        <div className="tech-title"><Cpu style={{ width: 13, height: 13 }} /> Training workbench</div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <label style={{ fontSize: 11, color: "var(--text-tertiary)", display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
            <input type="checkbox" checked={autoPromote} onChange={(e) => setAutoPromote(e.target.checked)} />
            auto-promote on success
          </label>
          <button className="btn btn-primary" onClick={train} disabled={training} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}>
            {training ? <Loader2 style={{ width: 13, height: 13 }} className="spin" /> : <Zap style={{ width: 13, height: 13 }} />}
            {training ? "Kicking off…" : "Train new model"}
          </button>
        </div>
      </div>
      {note && <div style={{ ...noteBar, margin: "0 0 14px" }}>{note}</div>}
      {loading ? (
        <div className="shimmer-line" />
      ) : runs.length === 0 ? (
        <p style={{ fontSize: 12, color: "var(--text-tertiary)" }}>No runs yet.</p>
      ) : (
        <table style={{ width: "100%", fontSize: 12 }}>
          <thead>
            <tr style={{ color: "var(--text-tertiary)" }}>
              <th style={{ textAlign: "left", padding: "4px 0" }}>Trained</th>
              <th style={{ textAlign: "right" }}>F1</th>
              <th style={{ textAlign: "right" }}>AUC</th>
              <th style={{ textAlign: "right" }}>n</th>
              <th style={{ textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {runs.slice(0, 8).map((r, i) => {
              const isActive = active?.id && r.id === active.id;
              return (
                <tr key={r.id ?? r.trained_at + i} style={{ borderTop: "1px solid var(--border-light)" }}>
                  <td style={{ padding: "7px 0" }}>
                    {new Date(r.trained_at).toLocaleDateString()}{" "}
                    {isActive && <span style={{ fontSize: 10, color: "#16a34a", fontWeight: 600, marginLeft: 6 }}>● active</span>}
                  </td>
                  <td style={{ textAlign: "right", fontWeight: 500 }} className="mono-num">{r.cv_f1?.toFixed(3) ?? "—"}</td>
                  <td style={{ textAlign: "right" }} className="mono-num">{r.cv_auc?.toFixed(3) ?? "—"}</td>
                  <td style={{ textAlign: "right", color: "var(--text-tertiary)" }} className="mono-num">{r.n_samples?.toLocaleString() ?? "—"}</td>
                  <td style={{ textAlign: "right" }}>
                    {!isActive && r.id && (
                      <button onClick={() => promote(r.id)} className="btn" style={{ fontSize: 11, padding: "3px 8px" }}>
                        Promote
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

/* ── Email quality: rubric editor ────────────────────────────────── */

export function RubricEditor() {
  const [rubric, setRubric] = useState<string>("");
  const [initial, setInitial] = useState<string>("");
  const [defaultRubric, setDefaultRubric] = useState<string>("");
  const [isDefault, setIsDefault] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    fetch("/api/scorer/rubric", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        setRubric(d.intro_rubric ?? "");
        setInitial(d.intro_rubric ?? "");
        setDefaultRubric(d.default_intro_rubric ?? "");
        setIsDefault(!!d.is_default);
      })
      .finally(() => setLoading(false));
  }, []);

  const dirty = rubric !== initial;

  async function save() {
    setSaving(true);
    setNote(null);
    try {
      const r = await fetch("/api/scorer/rubric", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intro_rubric: rubric }),
      });
      const d = await r.json();
      if (!r.ok) setNote(`❌ ${d.error}`);
      else {
        setInitial(rubric);
        setIsDefault(false);
        setNote("✓ Rubric saved. Next batch of judgings will use it.");
      }
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    setRubric(defaultRubric);
  }

  return (
    <div className="tech-card" style={{ marginBottom: 20 }}>
      <div className="tech-header">
        <div className="tech-title">
          <FileEdit style={{ width: 13, height: 13 }} />
          Rubric
          <span style={{ marginLeft: 8, fontSize: 10.5, color: isDefault ? "var(--text-tertiary)" : "#16a34a", fontWeight: 500 }}>
            {isDefault ? "using default" : "custom"}
          </span>
        </div>
        <button onClick={() => setExpanded((v) => !v)} className="btn" style={{ fontSize: 11, padding: "3px 8px" }}>
          {expanded ? "Hide" : "Edit"}
        </button>
      </div>
      {expanded && (
        <>
          {loading ? (
            <div className="shimmer-line" />
          ) : (
            <>
              <textarea
                value={rubric}
                onChange={(e) => setRubric(e.target.value)}
                rows={12}
                style={{
                  width: "100%",
                  padding: 10,
                  fontSize: 12,
                  lineHeight: 1.5,
                  fontFamily: "ui-monospace, monospace",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  resize: "vertical",
                  background: "var(--card)",
                  color: "var(--text)",
                  boxSizing: "border-box",
                }}
              />
              <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
                <button className="btn btn-primary" onClick={save} disabled={!dirty || saving} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                  {saving ? <Loader2 style={{ width: 13, height: 13 }} className="spin" /> : <Save style={{ width: 13, height: 13 }} />}
                  {saving ? "Saving…" : "Save rubric"}
                </button>
                <button className="btn" onClick={reset} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                  <RotateCcw style={{ width: 13, height: 13 }} />
                  Reset to default
                </button>
                {dirty && <span style={{ fontSize: 11, color: "#d97706" }}>unsaved changes</span>}
                {note && <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{note}</span>}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

/* ── Conversion: logistic-regression trainer ─────────────────────── */

interface LRModelDoc {
  featureNames: string[];
  weights: number[];
  intercept: number;
  nSamples: number;
  nPositive: number;
  auc: number;
  logLoss: number;
  trainLogLoss: number;
  iterations: number;
  trained_at?: string;
  trained_by?: string;
}

export function ConversionTrainer() {
  const [model, setModel] = useState<LRModelDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [training, setTraining] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    fetch("/api/scorer/conversion-model", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setModel(d.model ?? null))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { reload(); }, [reload]);

  async function train() {
    setTraining(true);
    setNote(null);
    try {
      const r = await fetch("/api/scorer/conversion-model", { method: "POST" });
      const d = await r.json();
      if (!r.ok) setNote(`❌ ${d.error}`);
      else {
        setModel(d.model);
        setNote(`✓ Trained on ${d.model.nSamples} samples (${d.model.nPositive} positive). Held-out AUC ${d.model.auc.toFixed(3)}.`);
      }
    } finally {
      setTraining(false);
    }
  }

  return (
    <div className="tech-card" style={{ marginBottom: 20 }}>
      <div className="tech-header">
        <div className="tech-title"><Zap style={{ width: 13, height: 13 }} /> Learned predictor</div>
        <button className="btn btn-primary" onClick={train} disabled={training} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}>
          {training ? <Loader2 style={{ width: 13, height: 13 }} className="spin" /> : <Zap style={{ width: 13, height: 13 }} />}
          {training ? "Fitting…" : model ? "Retrain" : "Train model"}
        </button>
      </div>
      {note && <div style={{ ...noteBar, margin: "0 0 12px" }}>{note}</div>}
      {loading ? (
        <div className="shimmer-line" />
      ) : !model ? (
        <p style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
          No trained model yet. Click <b>Train model</b> to fit a logistic regression on the current sent-recipient data.
        </p>
      ) : (
        <div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 12 }}>
            <MiniStat label="Held-out AUC" value={model.auc.toFixed(3)} />
            <MiniStat label="Train logloss" value={model.trainLogLoss.toFixed(3)} />
            <MiniStat label="Test logloss" value={model.logLoss.toFixed(3)} />
            <MiniStat label="Samples" value={`${model.nSamples} · ${model.nPositive}+`} />
          </div>
          <table style={{ width: "100%", fontSize: 12 }}>
            <thead>
              <tr style={{ color: "var(--text-tertiary)" }}>
                <th style={{ textAlign: "left", padding: "4px 0" }}>Feature</th>
                <th style={{ textAlign: "right" }}>Weight</th>
                <th style={{ textAlign: "right" }}>Effect</th>
              </tr>
            </thead>
            <tbody>
              {model.featureNames.map((n, i) => {
                const w = model.weights[i];
                return (
                  <tr key={n} style={{ borderTop: "1px solid var(--border-light)" }}>
                    <td style={{ padding: "5px 0" }}>{n}</td>
                    <td style={{ textAlign: "right", color: w > 0 ? "#16a34a" : w < 0 ? "#dc2626" : "var(--text-tertiary)", fontWeight: 500 }} className="mono-num">
                      {w >= 0 ? "+" : ""}{w.toFixed(3)}
                    </td>
                    <td style={{ textAlign: "right", color: "var(--text-tertiary)", fontSize: 11 }}>
                      {Math.abs(w) < 0.05 ? "negligible" : w > 0 ? "lifts conversion" : "hurts conversion"}
                    </td>
                  </tr>
                );
              })}
              <tr style={{ borderTop: "1px solid var(--border-light)" }}>
                <td style={{ padding: "5px 0", color: "var(--text-tertiary)" }}>intercept</td>
                <td style={{ textAlign: "right", color: "var(--text-tertiary)" }} className="mono-num">{model.intercept.toFixed(3)}</td>
                <td></td>
              </tr>
            </tbody>
          </table>
          {model.trained_at && (
            <p style={{ fontSize: 10.5, color: "var(--text-tertiary)", marginTop: 10 }}>
              Trained {new Date(model.trained_at).toLocaleString()}
              {model.trained_by ? ` by ${model.trained_by}` : ""} · {model.iterations} gradient steps
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ padding: 10, border: "1px solid var(--border-light)", borderRadius: 6, background: "var(--bg)" }}>
      <div style={{ fontSize: 10, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 3 }}>{label}</div>
      <div className="mono-num" style={{ fontSize: 16, fontWeight: 500 }}>{value}</div>
    </div>
  );
}

/* ── Match: rules console ────────────────────────────────────────── */

interface RulesConfig {
  strong_criteria: {
    min_citation: number;
    min_citation_unverified: number;
    max_school_tier: number;
    min_local_score: number;
  };
  assignment: {
    strong: { rep_id: number };
    overseas: { rep_id: number };
    domestic: { rep_id: number };
    by_direction?: Record<string, number>;
  };
}

export function RulesConsole() {
  const [config, setConfig] = useState<RulesConfig | null>(null);
  const [initial, setInitial] = useState<RulesConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<null | { nLeads: number; reroutes: number; tierFlips: number; byOldRep: Record<string, number>; byNewRep: Record<string, number> }>(null);
  const [previewing, setPreviewing] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/scorer/assignment-config", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        setConfig(d.current);
        setInitial(d.current);
      })
      .finally(() => setLoading(false));
  }, []);

  const dirty = JSON.stringify(config) !== JSON.stringify(initial);

  function updateCrit<K extends keyof RulesConfig["strong_criteria"]>(k: K, v: number) {
    if (!config) return;
    setConfig({ ...config, strong_criteria: { ...config.strong_criteria, [k]: v } });
  }

  async function doPreview() {
    if (!config) return;
    setPreviewing(true);
    try {
      const r = await fetch("/api/scorer/assignment-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config, preview: true }),
      });
      const d = await r.json();
      if (!r.ok) setNote(`❌ ${d.error}`);
      else setPreview(d);
    } finally {
      setPreviewing(false);
    }
  }

  async function save() {
    if (!config) return;
    setSaving(true);
    setNote(null);
    try {
      const r = await fetch("/api/scorer/assignment-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      });
      const d = await r.json();
      if (!r.ok) setNote(`❌ ${d.error}`);
      else {
        setInitial(config);
        setNote("✓ Rules saved. New leads use them immediately.");
      }
    } finally {
      setSaving(false);
    }
  }

  if (loading || !config) return <div className="tech-card" style={{ marginTop: 20 }}><div className="shimmer-line" /></div>;
  const crit = config.strong_criteria;

  return (
    <div className="tech-card" style={{ marginTop: 20 }}>
      <div className="tech-header">
        <div className="tech-title"><FileEdit style={{ width: 13, height: 13 }} /> Rules console</div>
        <div style={{ display: "flex", gap: 6 }}>
          <button className="btn" onClick={doPreview} disabled={!dirty || previewing} style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 6 }}>
            {previewing ? <Loader2 style={{ width: 13, height: 13 }} className="spin" /> : <Target style={{ width: 13, height: 13 }} />}
            Preview impact
          </button>
          <button className="btn btn-primary" onClick={save} disabled={!dirty || saving} style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 6 }}>
            {saving ? <Loader2 style={{ width: 13, height: 13 }} className="spin" /> : <Save style={{ width: 13, height: 13 }} />}
            Save
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <RuleInput label="Min citations (school verified)" value={crit.min_citation} onChange={(v) => updateCrit("min_citation", v)} />
        <RuleInput label="Min citations (school unknown)" value={crit.min_citation_unverified} onChange={(v) => updateCrit("min_citation_unverified", v)} />
        <RuleInput label="Max school tier for strong" value={crit.max_school_tier} min={1} max={3} onChange={(v) => updateCrit("max_school_tier", v)} />
        <RuleInput label="Min local score for strong" value={crit.min_local_score} step={0.05} min={0} max={1} onChange={(v) => updateCrit("min_local_score", v)} />
      </div>

      {preview && (
        <div style={{ marginTop: 14, padding: 12, background: "var(--bg)", border: "1px solid var(--border-light)", borderRadius: 6 }}>
          <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 8 }}>
            Preview across {preview.nLeads} leads:
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, fontSize: 12 }}>
            <div>
              <span style={{ color: "var(--text-tertiary)" }}>Reroutes:</span> <b className="mono-num">{preview.reroutes}</b>
              <span style={{ marginLeft: 8, color: "var(--text-tertiary)" }}>({Math.round((preview.reroutes / preview.nLeads) * 1000) / 10}%)</span>
            </div>
            <div>
              <span style={{ color: "var(--text-tertiary)" }}>Tier flips:</span> <b className="mono-num">{preview.tierFlips}</b>
              <span style={{ marginLeft: 8, color: "var(--text-tertiary)" }}>({Math.round((preview.tierFlips / preview.nLeads) * 1000) / 10}%)</span>
            </div>
          </div>
        </div>
      )}

      {note && <div style={{ ...noteBar, margin: "14px 0 0" }}>{note}</div>}
    </div>
  );
}

function RuleInput({ label, value, onChange, step, min, max }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</div>
      <input
        type="number"
        value={value}
        step={step ?? 1}
        min={min}
        max={max}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{
          width: "100%",
          padding: "6px 10px",
          fontSize: 13,
          fontFamily: "ui-monospace, monospace",
          border: "1px solid var(--border)",
          borderRadius: 6,
          background: "var(--card)",
          color: "var(--text)",
          boxSizing: "border-box",
        }}
      />
    </div>
  );
}


/* ── Citation backfill — fills citation_count / h_index for old leads ── */

interface BackfillResult {
  processed: number;
  updated: number;
  missed: number;
  errored: number;
  remaining: number;
  samples: { id: string; author: string; cite: number | null; h: number | null }[];
}

export function CitationBackfillCard() {
  const [running, setRunning] = useState(false);
  const [auto, setAuto] = useState(false);
  const [last, setLast] = useState<BackfillResult | null>(null);
  const [coverage, setCoverage] = useState<{ total: number; withCite: number; pending: number } | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const stopRef = useRef(false);

  const reloadCoverage = useCallback(async () => {
    // Cheap probe via /api/scorer/conversion (already returns withLeadData / totalSent)
    // — but we want pipeline_leads totals, so use a dedicated check via list.
    try {
      const r = await fetch("/api/scorer/training-data", { cache: "no-store" });
      const d = await r.json();
      // If training-data isn't ready, fall back to last result.
      if (d?.signals) {
        // No direct "leads with citation" — synthesize from history.
        // Better: just rely on what backfill calls return.
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { reloadCoverage(); }, [reloadCoverage]);

  async function runOnce(batchSize: number): Promise<BackfillResult | null> {
    const r = await fetch("/api/scorer/backfill-citations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batchSize }),
    });
    const d = await r.json();
    if (!r.ok) {
      setLog((p) => [`❌ ${d.error ?? "Failed"}`, ...p].slice(0, 8));
      return null;
    }
    setLast(d);
    setLog((p) => [
      `✓ batch: +${d.updated} filled, ${d.missed} S2 missed, ${d.errored} errored — ${d.remaining} remaining`,
      ...p,
    ].slice(0, 8));
    setCoverage((c) => c ? { ...c, pending: d.remaining } : null);
    return d;
  }

  async function runOne() {
    setRunning(true);
    try { await runOnce(20); } finally { setRunning(false); }
  }

  async function runUntilDone() {
    setRunning(true);
    setAuto(true);
    stopRef.current = false;
    try {
      let safety = 30; // hard stop after ~30 batches (~600 leads)
      while (safety-- > 0 && !stopRef.current) {
        const r = await runOnce(30);
        if (!r) break;
        if (r.remaining === 0) break;
        if (r.processed === 0) break;
        // Tiny breather to be polite to Semantic Scholar (which the route also rate-limits internally).
        await new Promise((res) => setTimeout(res, 1200));
      }
    } finally {
      setRunning(false);
      setAuto(false);
    }
  }

  function stopAuto() { stopRef.current = true; }

  return (
    <div className="tech-card" style={{ marginTop: 20 }}>
      <div className="tech-header">
        <div className="tech-title">
          <Cpu style={{ width: 13, height: 13 }} /> Citation backfill (Semantic Scholar)
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={runOne} disabled={running} className="btn" style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 6 }}>
            {running && !auto ? <Loader2 style={{ width: 13, height: 13 }} className="spin" /> : <Play style={{ width: 13, height: 13 }} />}
            One batch (20)
          </button>
          {auto ? (
            <button onClick={stopAuto} className="btn" style={{ fontSize: 12, color: "#dc2626" }}>
              Stop
            </button>
          ) : (
            <button onClick={runUntilDone} disabled={running} className="btn btn-primary" style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 6 }}>
              {running ? <Loader2 style={{ width: 13, height: 13 }} className="spin" /> : <Zap style={{ width: 13, height: 13 }} />}
              Backfill all
            </button>
          )}
        </div>
      </div>
      <p style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 10 }}>
        Walks every lead with an author name but no citation count, asks Semantic Scholar for h-index + citation count, fills in. Each batch is ~20 leads × ~3-5s = ~60-100s. Click <b>Backfill all</b> to keep firing batches until the queue is empty (auto stops on the 0 remaining).
        {coverage && (
          <span style={{ display: "block", marginTop: 4, color: "var(--text)" }}>
            Coverage: <b>{coverage.withCite}/{coverage.total}</b> have citations · <b>{coverage.pending}</b> still need backfill
          </span>
        )}
      </p>
      {last && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 10, fontSize: 12 }}>
          <Stat label="Last batch updated" value={String(last.updated)} />
          <Stat label="S2 missed" value={String(last.missed)} />
          <Stat label="Errored" value={String(last.errored)} tone={last.errored > 0 ? "alert" : undefined} />
          <Stat label="Remaining" value={String(last.remaining)} emphasis={last.remaining === 0} />
        </div>
      )}
      {log.length > 0 && (
        <div style={{ fontSize: 11, fontFamily: "ui-monospace, monospace", color: "var(--text-secondary)", lineHeight: 1.6, maxHeight: 140, overflowY: "auto", padding: 8, background: "var(--bg)", borderRadius: 6 }}>
          {log.map((line, i) => <div key={i}>{line}</div>)}
        </div>
      )}
      {last && last.samples.length > 0 && (
        <details style={{ marginTop: 10, fontSize: 11.5, color: "var(--text-secondary)" }}>
          <summary style={{ cursor: "pointer", color: "var(--text-tertiary)" }}>last batch samples</summary>
          <ul style={{ marginTop: 6, paddingLeft: 18 }}>
            {last.samples.map((s) => (
              <li key={s.id} style={{ fontFamily: "ui-monospace, monospace" }}>
                {s.author}: {s.cite ?? "—"} cites, h-index {s.h ?? "—"}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/* ── Industry backfill — fills industry_orgs from S2 + ack mining ─────── */

interface IndustryBackfillResult {
  processed: number;
  updated: number;
  viaS2: number;
  viaAck: number;
  remaining: number;
  samples: { id: string; author: string; orgs: string[]; source: string }[];
}

export function IndustryBackfillCard() {
  const [running, setRunning] = useState(false);
  const [auto, setAuto] = useState(false);
  const [last, setLast] = useState<IndustryBackfillResult | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const stopRef = useRef(false);

  async function runOnce(batchSize: number): Promise<IndustryBackfillResult | null> {
    const r = await fetch("/api/scorer/backfill-industry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batchSize }),
    });
    const d = await r.json();
    if (!r.ok) {
      setLog((p) => [`❌ ${d.error ?? "Failed"}`, ...p].slice(0, 8));
      return null;
    }
    setLast(d);
    setLog((p) => [
      `✓ batch: +${d.updated} found (S2: ${d.viaS2}, ack: ${d.viaAck}) — ${d.remaining} remaining`,
      ...p,
    ].slice(0, 8));
    return d;
  }

  async function runOne() { setRunning(true); try { await runOnce(15); } finally { setRunning(false); } }

  async function runUntilDone() {
    setRunning(true); setAuto(true); stopRef.current = false;
    try {
      let safety = 30;
      while (safety-- > 0 && !stopRef.current) {
        const r = await runOnce(20);
        if (!r) break;
        if (r.remaining === 0) break;
        if (r.processed === 0) break;
        await new Promise((res) => setTimeout(res, 1500));
      }
    } finally {
      setRunning(false); setAuto(false);
    }
  }

  function stopAuto() { stopRef.current = true; }

  return (
    <div className="tech-card" style={{ marginTop: 20 }}>
      <div className="tech-header">
        <div className="tech-title">
          <Cpu style={{ width: 13, height: 13 }} /> Industry affiliation backfill
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={runOne} disabled={running} className="btn" style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 6 }}>
            {running && !auto ? <Loader2 style={{ width: 13, height: 13 }} className="spin" /> : <Play style={{ width: 13, height: 13 }} />}
            One batch (15)
          </button>
          {auto ? (
            <button onClick={stopAuto} className="btn" style={{ fontSize: 12, color: "#dc2626" }}>Stop</button>
          ) : (
            <button onClick={runUntilDone} disabled={running} className="btn btn-primary" style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 6 }}>
              {running ? <Loader2 style={{ width: 13, height: 13 }} className="spin" /> : <Zap style={{ width: 13, height: 13 }} />}
              Backfill all
            </button>
          )}
        </div>
      </div>
      <p style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 10 }}>
        Detects industry orgs (OpenAI, Anthropic, Anyscale, Databricks, etc) from Semantic Scholar affiliations + paper acknowledgment mining (ar5iv HTML). An OpenAI intern with low cites is much stronger than the same person without that signal — these get +2500 to effective_citations in the strength scorer.
      </p>
      {last && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 10, fontSize: 12 }}>
          <Stat label="Last batch found" value={String(last.updated)} />
          <Stat label="Via S2" value={String(last.viaS2)} />
          <Stat label="Via ack mining" value={String(last.viaAck)} />
          <Stat label="Remaining" value={String(last.remaining)} emphasis={last.remaining === 0} />
        </div>
      )}
      {log.length > 0 && (
        <div style={{ fontSize: 11, fontFamily: "ui-monospace, monospace", color: "var(--text-secondary)", lineHeight: 1.6, maxHeight: 140, overflowY: "auto", padding: 8, background: "var(--bg)", borderRadius: 6 }}>
          {log.map((line, i) => <div key={i}>{line}</div>)}
        </div>
      )}
      {last && last.samples.length > 0 && (
        <details style={{ marginTop: 10, fontSize: 11.5, color: "var(--text-secondary)" }}>
          <summary style={{ cursor: "pointer", color: "var(--text-tertiary)" }}>last batch samples</summary>
          <ul style={{ marginTop: 6, paddingLeft: 18 }}>
            {last.samples.map((s) => (
              <li key={s.id}>
                <b>{s.author}</b>: 🏢 {s.orgs.join(", ")} <span style={{ color: "var(--text-tertiary)" }}>({s.source})</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
