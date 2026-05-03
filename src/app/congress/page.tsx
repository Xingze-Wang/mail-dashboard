// /congress — index of all council activity.
//
// Three sections, in order of "what does the admin actually need to see":
//   1. Pending decisions — tactical_proposals where ship_decision='pending'.
//      Click → /congress/proposals/[id] (full discussion).
//   2. Recent shipped — last 10 decisions, with status, expected vs actual.
//   3. Active strategic directives — what currently constrains Loop 2.
//
// Reps see read-only. Admin sees approve/reject inline.

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface Proposal {
  id: string;
  title: string;
  proposed_at: string;
  ship_decision: string;
  shipped_at: string | null;
  evaluation_due_at: string | null;
  expected_lift: { metric?: string; delta_pp?: number } | null;
  actual_lift: { open_rate?: number; click_rate?: number } | null;
  grade: string | null;
}

interface Directive {
  id: string;
  body: string;
  effective_from: string;
  active: boolean;
}

interface Decision {
  id: string;
  title: string;
  outcome: string;
  decided_at: string;
}

interface CongressData {
  pending: Proposal[];
  recent: Proposal[];
  directives: Directive[];
  recent_strategic: Decision[];
  jitr_offers_pending: number;
  jitr_offers_accepted_30d: number;
  unbound_reps: string[];
}

export default function CongressPage() {
  const [data, setData] = useState<CongressData | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/congress/index")
      .then((r) => (r.ok ? r.json() : null))
      .then(setData)
      .finally(() => setLoading(false));
  }, []);

  async function decide(id: string, approved: boolean) {
    setActing(id);
    try {
      const r = await fetch(`/api/tactical/${id}/decide?approved=${approved ? 1 : 0}`, { method: "POST" });
      if (r.ok) {
        // Refresh
        const fresh = await fetch("/api/congress/index").then((x) => x.json());
        setData(fresh);
      } else {
        alert(`decide failed: ${await r.text()}`);
      }
    } finally {
      setActing(null);
    }
  }

  if (loading) return <div style={{ padding: 24 }}>Loading…</div>;
  if (!data) return <div style={{ padding: 24, color: "var(--text-tertiary)" }}>No congress data — admin only.</div>;

  return (
    <div style={{ padding: "24px 32px", maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>Congress</h1>
        <p style={{ color: "var(--text-tertiary)", fontSize: 13, marginTop: 6 }}>
          Four loops. Daily JITR · Weekly Tactical · Monthly Strategic · Quarterly Postmortem.
        </p>
      </div>

      {/* Pending decisions — top of page, requires action */}
      <Section title={`Pending decisions (${data.pending.length})`} subtitle="Tactical proposals waiting for your approval">
        {data.pending.length === 0 ? (
          <Empty msg="Nothing pending. Loop 2 runs Monday 1am UTC." />
        ) : (
          data.pending.map((p) => (
            <div key={p.id} className="section-card" style={{ padding: 16, marginBottom: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Link href={`/congress/proposals/${p.id}`} style={{ fontSize: 15, fontWeight: 600, color: "var(--text)", textDecoration: "none" }}>
                    {p.title}
                  </Link>
                  <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 4 }}>
                    Proposed {fmt(p.proposed_at)} · Expected lift{" "}
                    {p.expected_lift?.delta_pp != null
                      ? `+${p.expected_lift.delta_pp}pp ${p.expected_lift.metric ?? ""}`
                      : "(unspecified)"}{" "}
                    · Evaluate after{" "}
                    {p.evaluation_due_at ? `${Math.ceil((new Date(p.evaluation_due_at).getTime() - Date.now()) / 86400000)}d` : "?"}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                  <button
                    onClick={() => decide(p.id, true)}
                    disabled={acting === p.id}
                    style={btnPrimary}
                  >
                    {acting === p.id ? "..." : "Approve"}
                  </button>
                  <button
                    onClick={() => decide(p.id, false)}
                    disabled={acting === p.id}
                    style={btnSecondary}
                  >
                    Reject
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </Section>

      {/* Recent shipped — what we approved + how it's grading */}
      <Section title="Recent decisions" subtitle="Last 10 tactical proposals + their grades">
        {data.recent.length === 0 ? (
          <Empty msg="No shipped decisions yet." />
        ) : (
          <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border-light)", color: "var(--text-tertiary)", textAlign: "left" }}>
                <th style={{ padding: "8px 6px", fontWeight: 500 }}>Title</th>
                <th style={{ padding: "8px 6px", fontWeight: 500 }}>Decision</th>
                <th style={{ padding: "8px 6px", fontWeight: 500 }}>Expected</th>
                <th style={{ padding: "8px 6px", fontWeight: 500 }}>Actual</th>
                <th style={{ padding: "8px 6px", fontWeight: 500 }}>Grade</th>
              </tr>
            </thead>
            <tbody>
              {data.recent.map((p) => (
                <tr key={p.id} style={{ borderBottom: "1px solid var(--border-light)" }}>
                  <td style={{ padding: "10px 6px" }}>
                    <Link href={`/congress/proposals/${p.id}`} style={{ color: "var(--text)", textDecoration: "none" }}>
                      {p.title}
                    </Link>
                  </td>
                  <td style={{ padding: "10px 6px" }}>
                    <span style={chip(p.ship_decision)}>{p.ship_decision}</span>
                  </td>
                  <td style={{ padding: "10px 6px", color: "var(--text-secondary)" }}>
                    {p.expected_lift?.delta_pp != null ? `+${p.expected_lift.delta_pp}pp` : "—"}
                  </td>
                  <td style={{ padding: "10px 6px", color: "var(--text-secondary)" }}>
                    {p.actual_lift?.click_rate != null ? `${(p.actual_lift.click_rate * 100).toFixed(2)}% click` : "—"}
                  </td>
                  <td style={{ padding: "10px 6px" }}>
                    {p.grade ? <span style={chip(p.grade)}>{p.grade}</span> : <span style={{ color: "var(--text-tertiary)" }}>pending</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {/* Active directives — what currently shapes Loop 2 */}
      <Section title={`Active strategic directives (${data.directives.length})`} subtitle="Loop 2 reads these as constraints every week">
        {data.directives.length === 0 ? (
          <Empty msg="No active directives. Monthly congress runs the 1st." />
        ) : (
          data.directives.map((d) => (
            <div key={d.id} className="section-card" style={{ padding: 14, marginBottom: 8, fontSize: 13 }}>
              <div style={{ color: "var(--text)" }}>{d.body}</div>
              <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 6 }}>
                Effective {fmt(d.effective_from)}
              </div>
            </div>
          ))
        )}
      </Section>

      {/* JITR status — Daily loop health */}
      <Section title="Daily JITR (Loop 1)" subtitle="Per-rep micro-decisions from drift patterns">
        <div className="section-card" style={{ padding: 14, fontSize: 13 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
            <Stat label="Offers pending" value={data.jitr_offers_pending} />
            <Stat label="Accepts (30d)" value={data.jitr_offers_accepted_30d} />
            <Stat label="Unbound reps" value={data.unbound_reps.length} />
          </div>
          {data.unbound_reps.length > 0 && (
            <div style={{ marginTop: 12, fontSize: 12, color: "var(--text-tertiary)" }}>
              Unbound: {data.unbound_reps.join(", ")} — they need to DM the bot once to be reachable.
            </div>
          )}
        </div>
      </Section>

      {/* Recent strategic decisions */}
      {data.recent_strategic.length > 0 && (
        <Section title="Recent strategic decisions" subtitle="From Monthly congress (Loop 3)">
          {data.recent_strategic.map((d) => (
            <div key={d.id} className="section-card" style={{ padding: 14, marginBottom: 8, fontSize: 13 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "var(--text)" }}>{d.title}</span>
                <span style={chip(d.outcome)}>{d.outcome}</span>
              </div>
              <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 4 }}>
                Decided {fmt(d.decided_at)}
              </div>
            </div>
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0, color: "var(--text)" }}>{title}</h2>
        {subtitle && <p style={{ fontSize: 12, color: "var(--text-tertiary)", margin: "4px 0 0 0" }}>{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

function Empty({ msg }: { msg: string }) {
  return <div style={{ padding: 16, fontSize: 13, color: "var(--text-tertiary)", fontStyle: "italic" }}>{msg}</div>;
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <div style={{ fontSize: 22, fontWeight: 600, color: "var(--text)" }}>{value}</div>
      <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>{label}</div>
    </div>
  );
}

function fmt(iso: string | null): string {
  if (!iso) return "?";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const btnPrimary: React.CSSProperties = {
  padding: "6px 14px", borderRadius: 6, border: "none", background: "#22c55e", color: "white",
  fontSize: 13, fontWeight: 500, cursor: "pointer",
};
const btnSecondary: React.CSSProperties = {
  padding: "6px 14px", borderRadius: 6, border: "1px solid var(--border)", background: "transparent",
  color: "var(--text)", fontSize: 13, fontWeight: 500, cursor: "pointer",
};

function chip(state: string): React.CSSProperties {
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
  return {
    display: "inline-block", padding: "2px 8px", borderRadius: 4, fontSize: 11,
    background: bg, color: fg, fontWeight: 500,
  };
}
