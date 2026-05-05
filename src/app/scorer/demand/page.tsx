// /scorer/demand — multi-model calibration vs observed recipient strength.
// Standard app vocabulary (mirrors /scorer/calibration's table layout).
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Play, MessageSquareMore } from "lucide-react";

interface BigMiss { lead_id: string; predicted: number; actual: number; diff: number }
interface ModelCal {
  model: string;
  n: number;
  pearson: number;
  spearman: number;
  mae_normalized: number;
  big_misses: BigMiss[];
}
interface Cal {
  ok: boolean;
  measured_at: string;
  n_leads: number;
  models: ModelCal[];
}

export default function DemandCalibrationPage() {
  const router = useRouter();
  const [cal, setCal] = useState<Cal | null>(null);
  const [commentary, setCommentary] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [interpreting, setInterpreting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = () => {
    setLoading(true);
    setErr(null);
    fetch("/api/scorer/demand")
      .then(async (r) => {
        if (r.status === 401) { router.replace("/login?next=/scorer/demand"); return null; }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => { if (d) setCal(d); })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(refresh, [router]);

  const askCongress = () => {
    setInterpreting(true);
    fetch("/api/scorer/demand", { method: "POST" })
      .then(async (r) => r.ok ? r.json() : null)
      .then((d) => { if (d) { setCal(d.calibration); setCommentary(d.commentary ?? "(no commentary)"); } })
      .finally(() => setInterpreting(false));
  };

  if (loading && !cal) return <div style={{ padding: 48, textAlign: "center", color: "var(--text-tertiary)" }}><Loader2 className="h-5 w-5 animate-spin" style={{ display: "inline-block" }} /></div>;
  if (err) return <div style={{ padding: 24, fontSize: 13, color: "var(--coral)" }}>{err}</div>;
  if (!cal) return null;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>
            Scorer · Demand calibration
          </div>
          <h1 className="page-title">How well do our models predict actual demand?</h1>
          <p style={{ fontSize: 13, color: "var(--text-tertiary)", marginTop: 4, maxWidth: 720, lineHeight: 1.55 }}>
            For each scoring model, we compare its prediction to <strong>actual observed strength</strong> — clicks (deduped), wechats, replies. Higher Pearson/Spearman = better-calibrated. Negative = anti-correlated (model is worse than random).
          </p>
        </div>
      </div>

      {cal.n_leads === 0 ? (
        <div className="section-card" style={{ padding: 24, textAlign: "center", fontSize: 13, color: "var(--text-tertiary)" }}>
          No recently-sent leads to calibrate against.
        </div>
      ) : (
        <>
          <div style={{ marginBottom: 16, fontSize: 12, color: "var(--text-tertiary)" }}>
            Measured on <strong>{cal.n_leads}</strong> leads, last 60 days. Updated {new Date(cal.measured_at).toLocaleString()}.
          </div>

          <div className="section-card" style={{ padding: 0, overflow: "hidden", marginBottom: 20 }}>
            <table className="data-table" style={{ marginBottom: 0 }}>
              <thead>
                <tr>
                  <th>Model</th>
                  <th style={{ textAlign: "right" }}>n</th>
                  <th style={{ textAlign: "right" }}>Pearson</th>
                  <th style={{ textAlign: "right" }}>Spearman</th>
                  <th style={{ textAlign: "right" }}>MAE (norm)</th>
                  <th>Top miss (pred / actual)</th>
                </tr>
              </thead>
              <tbody>
                {cal.models.map((m) => <Row key={m.model} m={m} />)}
              </tbody>
            </table>
          </div>

          <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
            <button onClick={askCongress} disabled={interpreting} className="btn btn-primary" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              {interpreting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageSquareMore className="h-3.5 w-3.5" />}
              {interpreting ? "Interpreting…" : "Ask congress to interpret"}
            </button>
            <button onClick={refresh} disabled={loading} className="btn">
              <Play className="h-3.5 w-3.5" style={{ display: "inline" }} /> Refresh
            </button>
          </div>

          {commentary && (
            <div className="section-card" style={{ padding: 18, borderLeft: "3px solid var(--blue)" }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>
                Congress diagnosis
              </div>
              <div style={{ fontSize: 13.5, lineHeight: 1.65, color: "var(--text)", whiteSpace: "pre-wrap" }}>
                {commentary}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Row({ m }: { m: ModelCal }) {
  // Color spearman: green if >0.5, gold if 0.1-0.5, coral if <0.1 (incl. negative)
  const sColor = m.spearman > 0.5 ? "var(--green)" : m.spearman > 0.1 ? "var(--gold)" : "var(--coral)";
  const pColor = m.pearson > 0.5 ? "var(--green)" : m.pearson > 0.1 ? "var(--gold)" : "var(--coral)";
  const top = m.big_misses[0];
  return (
    <tr>
      <td style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>{m.model}</td>
      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--text-tertiary)" }}>{m.n}</td>
      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: pColor, fontWeight: 600 }}>{m.pearson.toFixed(3)}</td>
      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: sColor, fontWeight: 600 }}>{m.spearman.toFixed(3)}</td>
      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{m.mae_normalized.toFixed(3)}</td>
      <td style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, color: "var(--text-tertiary)" }}>
        {top ? `${top.predicted.toFixed(2)} / ${top.actual.toFixed(2)} (Δ${top.diff.toFixed(2)})` : "—"}
      </td>
    </tr>
  );
}
