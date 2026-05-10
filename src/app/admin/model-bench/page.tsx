// /admin/model-bench
//
// Leaderboard of competing prompts × models for the three prediction
// families (persona_recipient / email_quality_judge / ctr_regressor).
// Prompts are seeded by scripts/_seed-model-prompts.mjs and evaluated
// daily by /api/cron/model-bench-eval. Admin can see which prompt
// best explains reality and ship the winner.
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2, Sparkles, Trophy, AlertTriangle } from "lucide-react";

interface BucketRow { range: string; predicted_n: number; actual_click_rate: number; }
interface LeaderboardRow {
  prompt_id: string;
  kind: string;
  name: string;
  llm_model: string;
  persona_archetype: string | null;
  predictions: number;
  mae: number | null;
  approval_agreement: number | null;
  buckets: BucketRow[];
  created_at: string;
}

export default function ModelBenchPage() {
  const router = useRouter();
  const [rows, setRows] = useState<LeaderboardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/model-bench")
      .then((r) => {
        if (r.status === 401) { router.replace("/login?next=/admin/model-bench"); return null; }
        if (r.status === 403) throw new Error("Admin only");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j) => { if (j) setRows(j.rows ?? []); })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, [router]);

  if (loading) return <div className="p-12 text-center text-sm text-slate-500"><Loader2 className="inline h-4 w-4 animate-spin" /> Loading bench…</div>;
  if (err) return <div className="p-6 text-sm text-red-700">Error: {err}</div>;

  const byKind: Record<string, LeaderboardRow[]> = { persona_recipient: [], email_quality_judge: [], ctr_regressor: [] };
  for (const r of rows) (byKind[r.kind] ??= []).push(r);

  return (
    <div style={{ padding: "24px 32px", maxWidth: 1200 }}>
      <h1 className="page-title">Model bench</h1>
      <p style={{ fontSize: 14, color: "var(--text-tertiary)", marginBottom: 24 }}>
        Three independent prediction models, each with multiple competing prompt × model variants.
        Daily cron evaluates each prompt against held-out reality. Lower MAE = better calibrated;
        higher approval-agreement = AI judge tracks admin.
      </p>

      <KindSection title="Model 1 — Persona recipient" subtitle="Predicts P(click) and P(apply) from a persona-acting LLM. Rated by mean abs error vs actual click outcome." rows={byKind.persona_recipient} kind="persona_recipient" />
      <KindSection title="Model 2 — Email-quality judge" subtitle="Predicts whether admin would approve a new template proposal. Rated by agreement with the actual approval/reject state." rows={byKind.email_quality_judge} kind="email_quality_judge" />
      <KindSection title="Model 3 — CTR regressor" subtitle="Predicts pure P(click) from features. Rated by calibration: in each predicted-bucket, what was the actual click rate?" rows={byKind.ctr_regressor} kind="ctr_regressor" />
    </div>
  );
}

function KindSection({ title, subtitle, rows, kind }: { title: string; subtitle: string; rows: LeaderboardRow[]; kind: string }) {
  const sorted = [...(rows ?? [])].sort((a, b) => {
    const ma = a.mae ?? a.approval_agreement ?? null;
    const mb = b.mae ?? b.approval_agreement ?? null;
    if (kind === "email_quality_judge") {
      // higher agreement is better
      return (b.approval_agreement ?? -1) - (a.approval_agreement ?? -1);
    }
    // lower MAE is better
    return (a.mae ?? 99) - (b.mae ?? 99);
  });

  return (
    <section style={{ marginBottom: 36 }}>
      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>{title}</h2>
      <p style={{ fontSize: 13, color: "var(--text-tertiary)", marginBottom: 14 }}>{subtitle}</p>
      {sorted.length === 0 && <p style={{ fontSize: 13, color: "var(--text-tertiary)", fontStyle: "italic" }}>No prompts seeded yet.</p>}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {sorted.map((row, i) => (
          <div key={row.prompt_id} style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "14px 18px", background: "var(--bg)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
              {i === 0 && row.predictions > 5 && <Trophy className="h-4 w-4 text-amber-500" />}
              <strong style={{ fontSize: 14 }}>{row.name}</strong>
              <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>{row.llm_model}</span>
              {row.persona_archetype && (
                <span style={{ fontSize: 11, padding: "2px 7px", borderRadius: 9, background: "var(--bg-elev)", color: "var(--text-secondary)" }}>
                  {row.persona_archetype}
                </span>
              )}
            </div>
            <div style={{ display: "flex", gap: 24, fontSize: 13, color: "var(--text-secondary)" }}>
              <Stat label="Predictions" value={row.predictions} />
              {row.mae !== null && <Stat label="MAE" value={row.mae.toFixed(3)} good={row.mae < 0.25} />}
              {row.approval_agreement !== null && <Stat label="Approval agreement" value={`${(row.approval_agreement * 100).toFixed(0)}%`} good={row.approval_agreement >= 0.7} />}
              {row.predictions === 0 && <span style={{ color: "var(--text-tertiary)", fontStyle: "italic" }}>awaiting first eval</span>}
            </div>
            {row.buckets.length > 0 && row.predictions > 0 && (
              <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 6 }}>
                {row.buckets.map((b) => (
                  <div key={b.range} style={{ fontSize: 11, padding: 6, borderRadius: 6, background: "var(--bg-elev)" }}>
                    <div style={{ color: "var(--text-tertiary)" }}>{b.range}</div>
                    <div>n={b.predicted_n} → {(b.actual_click_rate * 100).toFixed(0)}%</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function Stat({ label, value, good }: { label: string; value: string | number; good?: boolean }) {
  return (
    <span><span style={{ color: "var(--text-tertiary)" }}>{label}:</span> <strong style={{ color: good === true ? "rgb(22 163 74)" : good === false ? "rgb(220 38 38)" : "inherit" }}>{value}</strong></span>
  );
}
