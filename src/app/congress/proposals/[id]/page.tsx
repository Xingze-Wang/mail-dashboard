// /congress/proposals/[id] — full transcript of a tactical proposal.
// Shows the persona-by-persona discussion, the change spec, and (if
// applicable) approve/reject controls.

"use client";

import { useEffect, useState, use as usePromise } from "react";
import Link from "next/link";

interface Proposal {
  id: string;
  title: string;
  proposed_at: string;
  ship_decision: string;
  shipped_at: string | null;
  decided_at: string | null;
  decided_by: string | null;
  evaluation_due_at: string | null;
  weeks_to_evaluate: number;
  expected_lift: { metric?: string; delta_pp?: number; rationale?: string } | null;
  actual_lift: { sent?: number; open_rate?: number; click_rate?: number } | null;
  grade: string | null;
  change_spec: { kind?: string; details?: Record<string, unknown> } | null;
  deliberation: {
    personas?: Record<string, string>;
    change_spec?: object;
    evidence_pack_excerpt?: string;
  };
}

const PERSONA_ORDER = [
  "data_analyst",
  "copywriter",
  "academic_proxy",
  "sales_director",
  "psychologist",
  "adversary",
  "synthesizer",
];
const PERSONA_LABELS: Record<string, string> = {
  data_analyst: "📊 Data Analyst",
  copywriter: "✍️ Copywriter",
  academic_proxy: "🎓 Academic Proxy",
  sales_director: "👔 Sales Director",
  psychologist: "🧠 Psychologist",
  adversary: "⚔️ Adversary",
  synthesizer: "📋 Synthesizer (verdict)",
};

export default function ProposalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = usePromise(params);
  const [data, setData] = useState<Proposal | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);

  useEffect(() => {
    fetch(`/api/tactical/${id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setData)
      .finally(() => setLoading(false));
  }, [id]);

  async function decide(approved: boolean) {
    if (acting) return;
    setActing(true);
    try {
      const r = await fetch(`/api/tactical/${id}/decide?approved=${approved ? 1 : 0}`, { method: "POST" });
      if (r.ok) {
        const fresh = await fetch(`/api/tactical/${id}`).then((x) => x.json());
        setData(fresh);
      } else {
        alert(`decide failed: ${await r.text()}`);
      }
    } finally {
      setActing(false);
    }
  }

  if (loading) return <div style={{ padding: 24 }}>Loading…</div>;
  if (!data) return <div style={{ padding: 24, color: "var(--text-tertiary)" }}>Not found.</div>;

  const personas = data.deliberation?.personas ?? {};
  const evidence = data.deliberation?.evidence_pack_excerpt;

  return (
    <div style={{ padding: "24px 32px", maxWidth: 900, margin: "0 auto" }}>
      <Link href="/congress" style={{ fontSize: 12, color: "var(--text-tertiary)", textDecoration: "none" }}>
        ← Congress index
      </Link>

      <h1 style={{ fontSize: 22, fontWeight: 600, margin: "12px 0 8px 0" }}>{data.title}</h1>

      <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 20 }}>
        Proposed {fmt(data.proposed_at)} · Decision: <span style={chipStyle(data.ship_decision)}>{data.ship_decision}</span>
        {data.evaluation_due_at && (
          <> · Evaluate after {fmt(data.evaluation_due_at)}</>
        )}
        {data.grade && (
          <> · Graded: <span style={chipStyle(data.grade)}>{data.grade}</span></>
        )}
      </div>

      {/* Change spec — what would actually ship */}
      <Section title="Proposed change">
        <div style={{ background: "rgba(99,102,241,0.08)", padding: 14, borderRadius: 8, border: "1px solid rgba(99,102,241,0.2)" }}>
          <div style={{ fontSize: 12, color: "#6366f1", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
            {data.change_spec?.kind ?? "(no kind)"}
          </div>
          <pre style={{ margin: 0, fontSize: 12, whiteSpace: "pre-wrap", color: "var(--text)", fontFamily: "var(--font-mono, monospace)" }}>
            {JSON.stringify(data.change_spec?.details ?? {}, null, 2)}
          </pre>
          {data.expected_lift && (
            <div style={{ marginTop: 12, fontSize: 13, color: "var(--text-secondary)" }}>
              <strong>Expected lift:</strong> +{data.expected_lift.delta_pp}pp {data.expected_lift.metric}
              {data.expected_lift.rationale && (
                <div style={{ marginTop: 6, fontSize: 12, color: "var(--text-tertiary)" }}>{data.expected_lift.rationale}</div>
              )}
            </div>
          )}
        </div>
      </Section>

      {/* Approve / Reject — only if pending */}
      {data.ship_decision === "pending" && (
        <Section title="Decision">
          <div style={{ display: "flex", gap: 12 }}>
            <button onClick={() => decide(true)} disabled={acting} style={{ ...btnPrimary, padding: "10px 20px" }}>
              {acting ? "..." : "Approve"}
            </button>
            <button onClick={() => decide(false)} disabled={acting} style={{ ...btnSecondary, padding: "10px 20px" }}>
              Reject
            </button>
          </div>
          <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 8 }}>
            Approve auto-applies template_phrase_swap and copy_edit kinds. Other kinds require manual code change.
          </div>
        </Section>
      )}

      {/* Persona transcript — the actual debate */}
      <Section title="Council deliberation">
        {PERSONA_ORDER.filter((k) => personas[k]).map((key) => (
          <PersonaBlock key={key} personaKey={key} text={personas[key]} />
        ))}
      </Section>

      {/* Evidence excerpt — what the panel was looking at */}
      {evidence && (
        <Section title="Evidence pack (excerpt)">
          <pre style={{
            background: "var(--surface-secondary)",
            padding: 14,
            borderRadius: 8,
            fontSize: 11,
            color: "var(--text-secondary)",
            whiteSpace: "pre-wrap",
            maxHeight: 400,
            overflowY: "auto",
            border: "1px solid var(--border-light)",
          }}>
            {evidence}
          </pre>
        </Section>
      )}

      {data.actual_lift && (
        <Section title="Outcome (actual)">
          <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
            Sent: <strong>{data.actual_lift.sent ?? 0}</strong> · Open rate:{" "}
            <strong>{((data.actual_lift.open_rate ?? 0) * 100).toFixed(2)}%</strong> · Click rate:{" "}
            <strong>{((data.actual_lift.click_rate ?? 0) * 100).toFixed(2)}%</strong>
          </div>
        </Section>
      )}
    </div>
  );
}

function PersonaBlock({ personaKey, text }: { personaKey: string; text: string }) {
  const isVerdict = personaKey === "synthesizer";
  const isAdversary = personaKey === "adversary";

  // Try to render synthesizer's JSON nicely
  let renderText: string = text;
  if (isVerdict) {
    try {
      const cleaned = text.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
      const parsed = JSON.parse(cleaned);
      renderText = JSON.stringify(parsed, null, 2);
    } catch { /* keep raw */ }
  }

  return (
    <div style={{
      marginBottom: 14,
      paddingLeft: isAdversary ? 24 : 0,
      borderLeft: isAdversary ? "2px solid rgba(239,68,68,0.3)" : "none",
    }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 6 }}>
        {PERSONA_LABELS[personaKey] ?? personaKey}
      </div>
      <div style={{
        padding: 12,
        borderRadius: 8,
        background: isVerdict ? "rgba(99,102,241,0.06)" : "var(--surface-secondary)",
        border: isVerdict ? "1px solid rgba(99,102,241,0.2)" : "1px solid var(--border-light)",
        fontSize: 13,
        lineHeight: 1.6,
        color: "var(--text)",
        whiteSpace: "pre-wrap",
        fontFamily: isVerdict ? "var(--font-mono, monospace)" : "inherit",
      }}>
        {renderText}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <h2 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 12px 0", color: "var(--text)" }}>{title}</h2>
      {children}
    </div>
  );
}

function fmt(iso: string | null): string {
  if (!iso) return "?";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const btnPrimary: React.CSSProperties = { borderRadius: 6, border: "none", background: "#22c55e", color: "white", fontSize: 13, fontWeight: 500, cursor: "pointer" };
const btnSecondary: React.CSSProperties = { borderRadius: 6, border: "1px solid var(--border)", background: "transparent", color: "var(--text)", fontSize: 13, fontWeight: 500, cursor: "pointer" };

function chipStyle(state: string): React.CSSProperties {
  const colors: Record<string, [string, string]> = {
    pending: ["rgba(148,163,184,0.15)", "var(--text-secondary)"],
    approved: ["rgba(34,197,94,0.12)", "#22c55e"],
    rejected: ["rgba(239,68,68,0.12)", "#ef4444"],
    deferred: ["rgba(99,102,241,0.12)", "#6366f1"],
    hit: ["rgba(34,197,94,0.12)", "#22c55e"],
    partial: ["rgba(234,179,8,0.12)", "#eab308"],
    miss: ["rgba(239,68,68,0.12)", "#ef4444"],
    inconclusive: ["rgba(148,163,184,0.15)", "var(--text-secondary)"],
  };
  const [bg, fg] = colors[state] ?? colors.pending;
  return { display: "inline-block", padding: "2px 8px", borderRadius: 4, fontSize: 11, background: bg, color: fg, fontWeight: 500 };
}
