// /congress/editor — admin queue using standard app vocabulary.
// Same look as Overview/Pipeline: section cards, normal sans-serif body,
// CSS variables for color.
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2, CheckCircle2, XCircle, ArrowRight, Send } from "lucide-react";

interface Review {
  id: string;
  contract_id: string | null;
  proposed_change: Record<string, unknown>;
  verdict: "pass" | "block" | "revise";
  feedback: { issues: string[]; suggestions: string[]; severity: string };
  created_at: string;
}
interface Appeal {
  id: string;
  review_id: string;
  company_id: string;
  argument: string;
  status: "pending" | "upheld" | "denied" | "withdrawn";
  created_at: string;
  review: Review;
  company: { name: string; color: string };
}
interface Proposal {
  id: string;
  company_id: string;
  contract_id: string | null;
  kind: string;
  payload: Record<string, unknown>;
  prediction: string;
  state: string;
  created_at: string;
  expires_at: string;
  company: { name: string; color: string };
  editor_review: { verdict: string; feedback: { issues: string[]; suggestions: string[] } } | null;
}

export default function CongressEditorPage() {
  const router = useRouter();
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [appeals, setAppeals] = useState<Appeal[]>([]);
  const [blocks, setBlocks] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);

  const refresh = () => {
    setLoading(true);
    Promise.all([
      fetch("/api/proposals?state=admin_review").then(async (r) => {
        if (r.status === 401) { router.replace("/login?next=/congress/editor"); return null; }
        return r.ok ? r.json() : null;
      }),
      fetch("/api/editor/queue").then((r) => r.ok ? r.json() : null),
    ])
      .then(([propData, editorData]) => {
        if (propData) setProposals(propData.proposals ?? []);
        if (editorData) {
          setAppeals(editorData.appeals ?? []);
          setBlocks(editorData.blocked ?? []);
        }
      })
      .finally(() => setLoading(false));
  };
  useEffect(refresh, [router]);

  const decideProposal = async (id: string, decision: "approved" | "rejected") => {
    setActing(id);
    try {
      await fetch("/api/proposals/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proposal_id: id, decision }),
      });
      if (decision === "approved") {
        await fetch("/api/proposals/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ proposal_id: id }),
        });
      }
      refresh();
    } finally {
      setActing(null);
    }
  };

  const decideAppeal = async (id: string, decision: "upheld" | "denied") => {
    setActing(id);
    try {
      await fetch("/api/editor/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appeal_id: id, decision }),
      });
      refresh();
    } finally {
      setActing(null);
    }
  };

  if (loading && proposals.length === 0 && appeals.length === 0) {
    return (
      <div style={{ padding: 48, textAlign: "center", color: "var(--text-tertiary)" }}>
        <Loader2 className="h-5 w-5 animate-spin" style={{ display: "inline-block" }} />
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 className="page-title">Editor queue</h1>
          <p style={{ fontSize: 13, color: "var(--text-tertiary)", marginTop: 4 }}>
            {proposals.length === 0 && appeals.length === 0
              ? "No business pending."
              : `${proposals.length} proposal${proposals.length === 1 ? "" : "s"}, ${appeals.length} appeal${appeals.length === 1 ? "" : "s"} waiting on you.`}
          </p>
        </div>
      </div>

      {/* Proposals */}
      <Section title="Proposals waiting on you" count={proposals.length}>
        {proposals.length === 0 ? (
          <Empty text="No proposals pending admin decision." />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {proposals.map((p) => (
              <ProposalCard
                key={p.id}
                proposal={p}
                acting={acting === p.id}
                onDecide={(d) => decideProposal(p.id, d)}
              />
            ))}
          </div>
        )}
      </Section>

      {/* Appeals */}
      <Section title="Pending appeals" count={appeals.length}>
        {appeals.length === 0 ? (
          <Empty text="No appeals waiting." />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {appeals.map((a) => (
              <AppealCard
                key={a.id}
                appeal={a}
                acting={acting === a.id}
                onDecide={(d) => decideAppeal(a.id, d)}
              />
            ))}
          </div>
        )}
      </Section>

      {/* Recent blocks */}
      {blocks.length > 0 && (
        <Section title="Recent blocks (audit log)" count={blocks.length}>
          <div className="section-card" style={{ padding: 0, overflow: "hidden" }}>
            {blocks.slice(0, 8).map((b, i) => (
              <div key={b.id} style={{
                padding: "10px 14px",
                fontSize: 12.5,
                color: "var(--text-secondary)",
                lineHeight: 1.55,
                borderBottom: i === Math.min(blocks.length, 8) - 1 ? "none" : "1px solid var(--border-light)",
              }}>
                <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, color: "var(--text-tertiary)", marginRight: 12 }}>
                  {new Date(b.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                </span>
                {b.feedback.issues[0] ?? "(no detail)"}
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────

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
    <div className="section-card" style={{ padding: "20px 16px", textAlign: "center", fontSize: 13, color: "var(--text-tertiary)" }}>
      {text}
    </div>
  );
}

function ProposalCard({ proposal, acting, onDecide }: { proposal: Proposal; acting: boolean; onDecide: (d: "approved" | "rejected") => void }) {
  const p = proposal;
  const verdict = p.editor_review?.verdict;
  const verdictBg =
    verdict === "pass"   ? "rgba(34, 197, 94, 0.08)" :
    verdict === "revise" ? "rgba(245, 158, 11, 0.08)" :
    verdict === "block"  ? "rgba(239, 68, 68, 0.08)" :
    "transparent";
  const verdictColor =
    verdict === "pass"   ? "var(--green)" :
    verdict === "revise" ? "var(--gold)" :
    verdict === "block"  ? "var(--coral)" :
    "var(--text-tertiary)";
  const expiresIn = Math.max(0, Math.round((new Date(p.expires_at).getTime() - Date.now()) / 86_400_000));

  return (
    <div className="section-card" style={{
      padding: "16px 18px",
      borderLeft: `3px solid ${p.company.color}`,
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6, fontSize: 12 }}>
        <Send style={{ width: 13, height: 13, color: p.company.color }} />
        <span style={{ fontWeight: 600, fontSize: 13 }}>{p.company.name}</span>
        <span style={{ color: "var(--text-tertiary)" }}>proposes</span>
        <code style={{
          fontSize: 11,
          fontFamily: "ui-monospace, monospace",
          color: "var(--text-secondary)",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          padding: "1px 6px",
          borderRadius: 3,
          background: "var(--bg)",
        }}>
          {p.kind.replace(/_/g, " ")}
        </code>
        <span style={{ marginLeft: "auto", color: "var(--text-tertiary)" }}>expires in {expiresIn}d</span>
      </div>

      {/* Prediction */}
      {p.prediction && (
        <p style={{
          margin: "6px 0 12px",
          fontSize: 13.5,
          lineHeight: 1.55,
          color: "var(--text)",
        }}>
          {p.prediction}
        </p>
      )}

      {/* Editor verdict */}
      {verdict && (
        <div style={{
          marginBottom: 12,
          padding: "10px 12px",
          background: verdictBg,
          border: `1px solid ${verdictColor}33`,
          borderRadius: 6,
          fontSize: 12,
        }}>
          <div style={{
            fontSize: 11,
            fontWeight: 600,
            color: verdictColor,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            marginBottom: p.editor_review?.feedback?.issues?.length ? 6 : 0,
          }}>
            Editor: {verdict}
          </div>
          {p.editor_review?.feedback?.issues && p.editor_review.feedback.issues.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18, color: "var(--text-secondary)" }}>
              {p.editor_review.feedback.issues.map((it, i) => <li key={i}>{it}</li>)}
            </ul>
          )}
        </div>
      )}

      {/* Payload preview */}
      <details style={{ marginBottom: 14 }}>
        <summary style={{ cursor: "pointer", fontSize: 11, color: "var(--text-tertiary)" }}>
          What changes if approved
        </summary>
        <pre style={{
          marginTop: 8,
          padding: 12,
          background: "var(--bg)",
          border: "1px solid var(--border-light)",
          borderRadius: 6,
          fontSize: 11,
          fontFamily: "ui-monospace, monospace",
          color: "var(--text-secondary)",
          lineHeight: 1.55,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          overflowX: "auto",
        }}>
{JSON.stringify(p.payload, null, 2)}
        </pre>
      </details>

      {/* Actions */}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button onClick={() => onDecide("approved")} disabled={acting} className="btn btn-primary" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          {acting ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
          {acting ? "Approving…" : "Approve & execute"}
        </button>
        <button onClick={() => onDecide("rejected")} disabled={acting} className="btn" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <XCircle className="h-3 w-3" />
          Reject
        </button>
        {p.contract_id && (
          <Link href="/congress/timeline" style={{
            marginLeft: "auto",
            fontSize: 11.5,
            color: "var(--blue)",
            textDecoration: "none",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}>
            view in timeline <ArrowRight style={{ width: 11, height: 11 }} />
          </Link>
        )}
      </div>
    </div>
  );
}

function AppealCard({ appeal, acting, onDecide }: { appeal: Appeal; acting: boolean; onDecide: (d: "upheld" | "denied") => void }) {
  const a = appeal;
  return (
    <div className="section-card" style={{
      padding: "16px 18px",
      borderLeft: `3px solid ${a.company?.color ?? "var(--blue)"}`,
    }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8, fontSize: 12 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{a.company?.name ?? "(unknown)"}</span>
        <span style={{ color: "var(--text-tertiary)" }}>appeals editor block</span>
        <span style={{ marginLeft: "auto", color: "var(--text-tertiary)" }}>
          {new Date(a.created_at).toLocaleDateString()}
        </span>
      </div>

      <div style={{ marginBottom: 12 }}>
        <div style={{
          fontSize: 11,
          fontWeight: 600,
          color: "var(--coral)",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          marginBottom: 4,
        }}>
          Editor blocked because
        </div>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.55, color: "var(--text-secondary)" }}>
          {a.review.feedback.issues.map((it, i) => <li key={i}>{it}</li>)}
        </ul>
      </div>

      <div style={{ marginBottom: 14 }}>
        <div style={{
          fontSize: 11,
          fontWeight: 600,
          color: "var(--text-tertiary)",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          marginBottom: 4,
        }}>
          Company argues
        </div>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: "var(--text)" }}>
          {a.argument}
        </p>
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={() => onDecide("upheld")} disabled={acting} className="btn btn-primary" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          {acting ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
          Uphold (allow ship)
        </button>
        <button onClick={() => onDecide("denied")} disabled={acting} className="btn" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <XCircle className="h-3 w-3" />
          Deny (editor stands)
        </button>
      </div>
    </div>
  );
}
