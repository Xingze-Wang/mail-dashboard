// /congress — control-room view in standard app vocabulary.
// Uses page-title / section-card / dx-stat-strip patterns to match
// Overview, Pipeline, Emails, etc.

import Link from "next/link";
import { headers, cookies } from "next/headers";
import type { ControlRoomPayload } from "@/app/api/congress/control-room/route";

export const dynamic = "force-dynamic";

async function getControlRoom(): Promise<ControlRoomPayload | null> {
  const h = await headers();
  const c = await cookies();
  const host = h.get("host") ?? "calistamind.com";
  const proto = host.startsWith("localhost") ? "http" : "https";
  const cookieStr = c.getAll().map((x) => `${x.name}=${x.value}`).join("; ");
  const res = await fetch(`${proto}://${host}/api/congress/control-room`, {
    headers: { cookie: cookieStr },
    cache: "no-store",
  });
  if (!res.ok) return null;
  return res.json();
}

interface HypothesisRow {
  id: string;
  hypothesis: string;
  reasoning: string;
  segment: Record<string, unknown>;
  status: "proposed" | "testing" | "confirmed" | "refuted" | "abandoned";
  proposed_template_id: string | null;
  outcome_evidence: Record<string, unknown> | null;
  generated_at: string;
}

/** Pull recent hypotheses (active + recently-decided) directly from
 *  Supabase. Server-component only — uses service-role key implicitly
 *  via the server-side client. */
async function getHypotheses(): Promise<HypothesisRow[]> {
  // Use the same supabase client the rest of the app uses (admin-side)
  const { supabase } = await import("@/lib/db");
  const { data } = await supabase
    .from("congress_hypotheses")
    .select("id, hypothesis, reasoning, segment, status, proposed_template_id, outcome_evidence, generated_at")
    .order("generated_at", { ascending: false })
    .limit(20);
  return (data ?? []) as HypothesisRow[];
}

export default async function CongressWeeklyPage() {
  // Parallel fetch — control-room data + hypothesis stream. The
  // hypothesis section is additive; if the table read fails (e.g.
  // migration 065 not applied yet) we just show no hypotheses.
  const [data, hypotheses] = await Promise.all([
    getControlRoom(),
    getHypotheses().catch(() => [] as HypothesisRow[]),
  ]);
  if (!data) {
    return (
      <div className="section-card" style={{ padding: 16 }}>
        <p style={{ fontSize: 13, color: "var(--text-tertiary)", margin: 0 }}>
          Unable to load control room — sign in as admin.
        </p>
      </div>
    );
  }

  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  const pendingCount = data.pending_proposals.filter((p) => p.state === "admin_review").length;

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 className="page-title">Weekly congress</h1>
          <p style={{ fontSize: 13, color: "var(--text-tertiary)", marginTop: 4 }}>
            {today} · {pendingCount === 0 ? "no decisions waiting" : `${pendingCount} decision${pendingCount === 1 ? "" : "s"} need your call`}
          </p>
        </div>
      </div>

      {/* Vital signs strip */}
      <Vitals data={data} />

      {/* Pending decisions */}
      <Section title="Pending your decision" count={pendingCount}>
        {pendingCount === 0 ? (
          <Empty text="The desk is clear." />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {data.pending_proposals.filter((p) => p.state === "admin_review").map((p) => (
              <ProposalRow key={p.id} p={p} />
            ))}
          </div>
        )}
      </Section>

      {/* Hypothesis stream — written by weekly congress when its
          synthesizer outputs a template-related change_spec. Migration
          065 table. Active proposed/testing first, then recently
          decided (confirmed/refuted) for context. */}
      <Section title="Hypotheses in flight" count={hypotheses.filter((h) => h.status === "proposed" || h.status === "testing").length}>
        {hypotheses.length === 0 ? (
          <Empty text="No hypotheses yet — weekly congress writes them when it proposes template changes." />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {hypotheses.map((h) => <HypothesisRowCmp key={h.id} h={h} />)}
          </div>
        )}
      </Section>

      {/* Recent contracts */}
      <Section title="Recent contracts" count={data.recent_contracts.length}>
        {data.recent_contracts.length === 0 ? (
          <Empty text="No contracts on record yet." />
        ) : (
          <ContractsTable rows={data.recent_contracts} />
        )}
      </Section>

      {/* Conviction shifts */}
      {data.top_movers.length > 0 && (
        <Section title="Conviction shifts this week" count={data.top_movers.length}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 8 }}>
            {data.top_movers.map((m, i) => <MoverRow key={i} m={m} />)}
          </div>
        </Section>
      )}

      {/* Standing directives */}
      {data.active_directives.length > 0 && (
        <Section title="Standing directives" count={data.active_directives.length}>
          <div className="section-card" style={{ padding: 0, overflow: "hidden" }}>
            {data.active_directives.map((d, i) => (
              <div key={d.id} style={{
                padding: "12px 16px",
                fontSize: 13,
                lineHeight: 1.6,
                color: "var(--text-secondary)",
                borderBottom: i === data.active_directives.length - 1 ? "none" : "1px solid var(--border-light)",
              }}>
                {d.body}
                <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-tertiary)" }}>
                  Effective {new Date(d.effective_from).toLocaleDateString()}
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Footer */}
      <Footer data={data} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────

function Vitals({ data }: { data: ControlRoomPayload }) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
      gap: 12,
      marginBottom: 28,
    }}>
      {data.vitals.map((v, i) => <VitalCell key={i} v={v} />)}
    </div>
  );
}

function VitalCell({ v }: { v: ControlRoomPayload["vitals"][number] }) {
  const tone = v.tone ?? "neutral";
  const valueColor =
    tone === "warn" ? "var(--gold)" :
    tone === "bad"  ? "var(--coral)" :
    tone === "good" ? "var(--green)" :
    "var(--text)";

  const inner = (
    <div className="section-card" style={{ padding: "14px 16px" }}>
      <div style={{
        fontSize: 11,
        fontWeight: 600,
        color: "var(--text-tertiary)",
        textTransform: "uppercase",
        letterSpacing: "0.04em",
      }}>
        {v.label}
      </div>
      <div style={{
        marginTop: 6,
        fontSize: 22,
        fontWeight: 700,
        color: valueColor,
        lineHeight: 1.1,
        fontVariantNumeric: "tabular-nums",
      }}>
        {v.value}
      </div>
      {v.delta && (
        <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-tertiary)" }}>{v.delta}</div>
      )}
    </div>
  );
  if (v.href) {
    return <Link href={v.href} style={{ display: "block", textDecoration: "none", color: "inherit" }}>{inner}</Link>;
  }
  return inner;
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{title}</h3>
        <span className="lead-count">{count}</span>
      </div>
      {children}
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="section-card" style={{
      padding: "20px 16px",
      textAlign: "center",
      fontSize: 13,
      color: "var(--text-tertiary)",
    }}>
      {text}
    </div>
  );
}

function ProposalRow({ p }: { p: ControlRoomPayload["pending_proposals"][number] }) {
  const verdictColor =
    p.editor_verdict === "pass"   ? "var(--green)" :
    p.editor_verdict === "revise" ? "var(--gold)" :
    p.editor_verdict === "block"  ? "var(--coral)" :
    "var(--text-tertiary)";
  return (
    <Link href="/congress/editor" style={{ textDecoration: "none", color: "inherit" }}>
      <div className="section-card" style={{
        padding: "14px 16px",
        borderLeft: `3px solid ${p.company_color}`,
        transition: "border-color 0.15s ease",
      }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6, fontSize: 12 }}>
          <span style={{ fontWeight: 600, color: "var(--text)" }}>{p.company_name}</span>
          <span style={{ color: "var(--text-tertiary)" }}>·</span>
          <code style={{
            fontSize: 11,
            fontFamily: "ui-monospace, monospace",
            color: "var(--text-secondary)",
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}>
            {p.kind.replace(/_/g, " ")}
          </code>
          {p.editor_verdict && (
            <>
              <span style={{ color: "var(--text-tertiary)" }}>·</span>
              <span style={{
                fontSize: 11,
                fontWeight: 600,
                color: verdictColor,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
              }}>
                editor: {p.editor_verdict}
              </span>
            </>
          )}
          <span style={{ marginLeft: "auto", color: "var(--text-tertiary)" }}>
            expires {p.expires_in_days}d
          </span>
        </div>
        {p.prediction && (
          <p style={{
            margin: 0,
            fontSize: 13,
            lineHeight: 1.55,
            color: "var(--text-secondary)",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}>
            {p.prediction}
          </p>
        )}
      </div>
    </Link>
  );
}

function ContractsTable({ rows }: { rows: ControlRoomPayload["recent_contracts"] }) {
  return (
    <div className="section-card" style={{ padding: 0, overflow: "hidden" }}>
      <table className="data-table" style={{ marginBottom: 0 }}>
        <thead>
          <tr>
            <th>Company</th>
            <th>Action</th>
            <th>Segment</th>
            <th style={{ textAlign: "right" }}>Score</th>
            <th style={{ textAlign: "right" }}>Outcome</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const stateColor =
              c.state === "hit"    ? "var(--green)" :
              c.state === "missed" ? "var(--coral)" :
              c.state === "open"   ? "var(--gold)" :
              "var(--text-tertiary)";
            return (
              <tr key={c.id}>
                <td>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: c.company_color, flexShrink: 0 }} />
                    <span style={{ fontWeight: 500 }}>{c.company_name}</span>
                  </span>
                </td>
                <td style={{ color: "var(--text-secondary)" }}>{c.action_label}</td>
                <td style={{ color: "var(--text-tertiary)", fontSize: 11.5 }}>{c.segment ?? "—"}</td>
                <td style={{ textAlign: "right", fontWeight: 600, color: stateColor }}>
                  {Math.round(c.running_score)}/{Math.round(c.target_score)}
                </td>
                <td style={{
                  textAlign: "right",
                  fontSize: 11,
                  fontWeight: 600,
                  color: stateColor,
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                }}>
                  {c.state}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MoverRow({ m }: { m: ControlRoomPayload["top_movers"][number] }) {
  const direction = m.next > m.prior ? "↑" : m.next < m.prior ? "↓" : "→";
  const dirColor = m.next > m.prior ? "var(--green)" : m.next < m.prior ? "var(--coral)" : "var(--text-tertiary)";
  return (
    <div className="section-card" style={{ padding: "12px 14px", borderLeft: `3px solid ${m.company_color}` }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{m.company_name}</span>
        <span style={{ fontSize: 13, color: dirColor, fontWeight: 700 }}>{direction}</span>
        <span style={{ fontSize: 12, color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>
          {m.prior.toFixed(2)} → {m.next.toFixed(2)}
        </span>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-tertiary)", display: "flex", justifyContent: "space-between" }}>
        <span style={{ textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 600 }}>{m.action}</span>
        <span>{new Date(m.occurred_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
      </div>
    </div>
  );
}

function Footer({ data }: { data: ControlRoomPayload }) {
  return (
    <div style={{
      marginTop: 28,
      paddingTop: 14,
      borderTop: "1px solid var(--border-light)",
      display: "flex",
      flexWrap: "wrap",
      gap: "4px 18px",
      fontSize: 11.5,
      color: "var(--text-tertiary)",
    }}>
      <span><code style={{ fontFamily: "ui-monospace, monospace", color: "var(--text-secondary)" }}>{data.jitr_pending}</code> JITR pending</span>
      <span><code style={{ fontFamily: "ui-monospace, monospace", color: "var(--text-secondary)" }}>{data.jitr_accepted_30d}</code> JITR accepted (30d)</span>
      {data.unbound_reps.length > 0 && (
        <span>Unbound reps: {data.unbound_reps.join(", ")} — DM the bot once.</span>
      )}
      <span style={{ marginLeft: "auto" }}>Updated {new Date(data.generated_at).toLocaleTimeString()}</span>
    </div>
  );
}

/** One hypothesis row — shows the assertion, reasoning collapsed,
 *  current status badge, and outcome data if any. */
function HypothesisRowCmp({ h }: { h: HypothesisRow }) {
  const statusStyle = {
    proposed: { bg: "var(--tag-warn-bg, #fff7ed)", color: "#b45309", border: "#fcd34d" },
    testing: { bg: "var(--tag-info-bg, #dbeafe)", color: "#1d4ed8", border: "#93c5fd" },
    confirmed: { bg: "var(--tag-ok-bg, #d1fae5)", color: "#059669", border: "#6ee7b7" },
    refuted: { bg: "var(--tag-bad-bg, #fee2e2)", color: "#dc2626", border: "#fca5a5" },
    abandoned: { bg: "#f1f5f9", color: "#64748b", border: "#cbd5e1" },
  }[h.status];

  const seg = h.segment ?? {};
  const segLabel = Object.entries(seg)
    .map(([k, v]) => `${k}=${v}`)
    .join(" / ") || "—";

  // Outcome line (only if testing/confirmed/refuted with evidence)
  let outcome: string | null = null;
  if (h.outcome_evidence) {
    const e = h.outcome_evidence as Record<string, unknown>;
    const vp = typeof e.value_proposal === "number" ? (e.value_proposal as number) * 100 : null;
    const vb = typeof e.value_baseline === "number" ? (e.value_baseline as number) * 100 : null;
    const sp = e.sample_proposal as number | undefined;
    const sb = e.sample_baseline as number | undefined;
    if (vp != null && vb != null) {
      outcome = `proposal ${vp.toFixed(1)}% (n=${sp}) vs baseline ${vb.toFixed(1)}% (n=${sb})`;
    }
  }

  return (
    <div className="section-card" style={{ padding: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 4 }}>
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            padding: "2px 6px",
            borderRadius: 3,
            background: statusStyle.bg,
            color: statusStyle.color,
            border: `1px solid ${statusStyle.border}`,
            flexShrink: 0,
          }}
        >
          {h.status}
        </span>
        <span style={{ fontSize: 10, color: "var(--text-tertiary)", flexShrink: 0 }}>
          {segLabel}
        </span>
      </div>
      <p style={{ fontSize: 13, lineHeight: 1.5, margin: "4px 0", color: "var(--text-primary)" }}>
        {h.hypothesis}
      </p>
      <details style={{ marginTop: 4 }}>
        <summary style={{ fontSize: 11, color: "var(--text-tertiary)", cursor: "pointer" }}>
          Reasoning
        </summary>
        <p
          style={{
            fontSize: 12,
            lineHeight: 1.5,
            margin: "6px 0 0",
            color: "var(--text-secondary)",
            whiteSpace: "pre-wrap",
          }}
        >
          {h.reasoning}
        </p>
      </details>
      {outcome && (
        <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-secondary)", fontFamily: "var(--font-mono, monospace)" }}>
          {outcome}
        </div>
      )}
      {h.proposed_template_id && (
        <div style={{ marginTop: 4, fontSize: 11 }}>
          <Link
            href={`/templates/${h.proposed_template_id}/inspect`}
            style={{ color: "var(--link-color, #0070f3)" }}
          >
            View test template →
          </Link>
        </div>
      )}
    </div>
  );
}
