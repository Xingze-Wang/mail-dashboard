"use client";

import { useEffect, useState, useCallback } from "react";
import { Loader2, Check, X, ArrowRight } from "lucide-react";

interface CandidateRow {
  id: string;
  headline: string;
  body: string;
  status: string;
  created_at: string;
  evidence: {
    rep_id?: number;
    per_rep_template_id?: string;
    global_template_id?: string;
    sample_size?: number;
    actual_per_rep?: { clicked: number; sent: number; rate: number; wilson_lower: number; wilson_upper: number };
    actual_global?:  { clicked: number; sent: number; rate: number; wilson_lower: number; wilson_upper: number };
    predicted_per_rep?: number;
    predicted_global?: number;
    predicted_lift?: number;
  };
}

interface PageData {
  pending: CandidateRow[];
  decided: Array<{ id: string; headline: string; status: string; created_at: string }>;
}

export default function CandidatesPage() {
  const [data, setData] = useState<PageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch("/api/admin/templates/candidates", { credentials: "include", cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData(await r.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const decide = async (id: string, action: "approve" | "reject") => {
    setActing(id);
    try {
      const r = await fetch("/api/admin/templates/candidates", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inbox_id: id, action }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setActing(null); }
  };

  if (loading) return <div style={{ padding: 24 }}><Loader2 size={14} className="animate-spin" /> Loading&hellip;</div>;
  if (error) return <div style={{ padding: 24, color: "#f87171" }}>Error: {error}</div>;
  if (!data) return null;

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 4 }}>Template candidates</h1>
      <p style={{ color: "#94a3b8", marginBottom: 24, fontSize: 13 }}>
        Per-rep templates that beat the current global on both actual clicks (Wilson CI) and predicted clicks (ctr_regressor).
        Approve to clone into a new global proposal; the existing template-auto-promote pipeline takes it from there.
      </p>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 14, color: "#94a3b8", marginBottom: 12 }}>Pending ({data.pending.length})</h2>
        {data.pending.length === 0 ? (
          <p style={{ color: "#64748b", fontSize: 13 }}>No candidates pending. Comes from /api/cron/candidate-global-promote (Mon 03:00 Beijing weekly).</p>
        ) : (
          data.pending.map((c) => {
            const a = c.evidence.actual_per_rep;
            const ag = c.evidence.actual_global;
            const liftActual = a && ag ? (a.rate - ag.rate) / Math.max(ag.rate, 1e-6) : null;
            const liftPredicted = c.evidence.predicted_lift ?? null;
            return (
              <div key={c.id} style={{
                marginBottom: 16, padding: 16,
                border: "1px solid #1e293b", borderRadius: 8,
              }}>
                <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>{c.headline}</div>
                <pre style={{ fontSize: 12, color: "#94a3b8", whiteSpace: "pre-wrap", marginBottom: 12 }}>{c.body}</pre>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 12 }}>
                  <div>
                    <div style={{ fontSize: 11, color: "#64748b" }}>Actual CTR (Wilson 95% CI)</div>
                    <div style={{ fontSize: 14 }}>
                      Per-rep: {a ? `${(a.rate * 100).toFixed(1)}% [${(a.wilson_lower * 100).toFixed(1)}, ${(a.wilson_upper * 100).toFixed(1)}]` : "—"}
                    </div>
                    <div style={{ fontSize: 14 }}>
                      Global:  {ag ? `${(ag.rate * 100).toFixed(1)}% [${(ag.wilson_lower * 100).toFixed(1)}, ${(ag.wilson_upper * 100).toFixed(1)}]` : "—"}
                    </div>
                    {liftActual !== null && (
                      <div style={{ fontSize: 12, color: liftActual > 0 ? "#10b981" : "#f87171" }}>
                        relative lift {(liftActual * 100).toFixed(0)}%
                      </div>
                    )}
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: "#64748b" }}>Predicted p_click (avg)</div>
                    <div style={{ fontSize: 14 }}>Per-rep: {(c.evidence.predicted_per_rep ?? 0).toFixed(3)}</div>
                    <div style={{ fontSize: 14 }}>Global:  {(c.evidence.predicted_global ?? 0).toFixed(3)}</div>
                    {liftPredicted !== null && (
                      <div style={{ fontSize: 12, color: liftPredicted > 1 ? "#10b981" : "#f87171" }}>
                        ratio {liftPredicted.toFixed(2)}&times;
                      </div>
                    )}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={() => void decide(c.id, "approve")}
                    disabled={acting === c.id}
                    style={{
                      padding: "6px 14px", fontSize: 13, fontWeight: 500,
                      background: "#10b981", color: "white",
                      border: "none", borderRadius: 6, cursor: "pointer",
                      display: "flex", alignItems: "center", gap: 6,
                    }}
                  >
                    <Check size={14} /> Promote to global proposal <ArrowRight size={14} />
                  </button>
                  <button
                    onClick={() => void decide(c.id, "reject")}
                    disabled={acting === c.id}
                    style={{
                      padding: "6px 14px", fontSize: 13,
                      background: "transparent", color: "#94a3b8",
                      border: "1px solid #1e293b", borderRadius: 6, cursor: "pointer",
                      display: "flex", alignItems: "center", gap: 6,
                    }}
                  >
                    <X size={14} /> Reject &mdash; keep per-rep only
                  </button>
                </div>
              </div>
            );
          })
        )}
      </section>

      <section>
        <h2 style={{ fontSize: 14, color: "#94a3b8", marginBottom: 12 }}>Recent decisions ({data.decided.length})</h2>
        {data.decided.length === 0 ? (
          <p style={{ color: "#64748b", fontSize: 13 }}>None.</p>
        ) : (
          <ul style={{ fontSize: 12, color: "#94a3b8", listStyle: "none", padding: 0 }}>
            {data.decided.map((d) => (
              <li key={d.id} style={{ padding: "6px 0", borderBottom: "1px solid #0f172a" }}>
                <span style={{ color: d.status === "approved" ? "#10b981" : "#64748b", textTransform: "uppercase", fontSize: 10 }}>{d.status}</span>{" — "}
                {d.headline}{" "}
                <span style={{ color: "#475569" }}>&middot; {new Date(d.created_at).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
