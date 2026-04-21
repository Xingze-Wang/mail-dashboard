// Extracted tab components for /scorer — keeps page.tsx focused on the
// established Lead-quality view. Each tab fetches its own endpoint lazily.
"use client";

import { useCallback, useEffect, useState } from "react";
import {
  BarChart, Bar, LineChart, Line,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import { Sparkles, Target, Users2, Play, Loader2, AlertTriangle, TrendingUp } from "lucide-react";

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
  byScore: ConvBucket[];
  byTier: ConvBucket[];
  byCitations: ConvBucket[];
  bySchoolTier: ConvBucket[];
  byRep: ConvBucket[];
  byDirection: ConvBucket[];
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
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginBottom: 20 }}>
        <Stat label="Baseline conv rate" value={`${data.baseline}%`} sub={`${data.totalConverted} / ${data.totalSent}`} emphasis />
        <Stat label="Total sent" value={data.totalSent.toString()} />
        <Stat label="WeChat adds" value={data.totalConverted.toString()} />
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

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <BucketTable title="By score" buckets={data.byScore} baseline={data.baseline} />
        <BucketTable title="By tier" buckets={data.byTier} baseline={data.baseline} />
        <BucketTable title="By citations" buckets={data.byCitations} baseline={data.baseline} />
        <BucketTable title="By school tier" buckets={data.bySchoolTier} baseline={data.baseline} />
        <BucketTable title="By rep" buckets={data.byRep} baseline={data.baseline} />
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
