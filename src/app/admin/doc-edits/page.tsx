"use client";

// /admin/doc-edits
//
// Admin review surface for Leon's proposed Lark-doc edits. Per the
// app-level rule ("everything you can do via Lark must also work via
// the dashboard"), every action here mirrors a Lark text command:
//   - Approve   ⇄ "approve doc edit <id>" in Lark
//   - Reject    ⇄ "reject doc edit <id> <reason>" in Lark
//   - Dismiss   ⇄ "dismiss doc edit <id>" in Lark
//
// Same proposal row, same DB transition, just two surfaces into it.

import { use, useEffect, useState } from "react";
import { Loader2, ExternalLink, FileEdit, Check, X, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";

interface EditStep {
  action: "update" | "delete" | "insert_at" | "append";
  block_id?: string;
  block_type?: number;
  new_text?: string;
  block_ids?: string[];
  index?: number;
  blocks?: Array<Record<string, unknown>>;
}

interface Proposal {
  id: string;
  document_id: string;
  document_url: string;
  document_title: string | null;
  summary: string;
  narration: string | null;
  edits: EditStep[];
  status: "pending" | "approved" | "rejected" | "dismissed" | "applied";
  proposed_by_rep_id: number | null;
  proposed_by_name: string | null;
  applied_at: string | null;
  apply_error: string | null;
  decision_note: string | null;
  created_at: string;
}

const STATUSES = ["pending", "approved", "applied", "rejected", "dismissed"] as const;
type Status = (typeof STATUSES)[number];

export default function DocEditsPage() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("pending");
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = async (s: Status) => {
    setLoading(true);
    setMsg(null);
    try {
      const r = await fetch(`/api/admin/doc-edits?status=${s}`, { credentials: "include" });
      if (r.status === 401) { router.replace("/login?next=/admin/doc-edits"); return; }
      if (r.status === 403) { setMsg("Admin only"); return; }
      if (!r.ok) { setMsg(`Failed (${r.status})`); return; }
      const j = await r.json();
      setProposals(j.proposals ?? []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(status); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [status]);

  const act = async (proposalId: string, action: "approve" | "reject" | "dismiss") => {
    let reason: string | undefined;
    if (action === "reject") {
      const r = window.prompt("Reject reason (≥10 chars — goes into next congress evidence):");
      if (!r || r.trim().length < 10) {
        setMsg("Reject cancelled — need ≥10 chars");
        return;
      }
      reason = r.trim();
    }
    setBusy(proposalId);
    setMsg(null);
    try {
      const r = await fetch("/api/admin/doc-edits", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proposal_id: proposalId, action, reason }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMsg(`Failed: ${j.error ?? r.status}`);
        return;
      }
      setMsg(action === "approve" ? `Approved + applied (${j.applied_steps ?? 0} steps).` : `${action[0].toUpperCase() + action.slice(1)}ed.`);
      await load(status);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "24px 32px" }}>
      <h1 className="page-title" style={{ fontSize: 22, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
        <FileEdit className="h-5 w-5" /> Doc edit proposals
      </h1>
      <p style={{ fontSize: 13, color: "var(--text-tertiary)", marginBottom: 20 }}>
        Structured edits Leon wants to make to Lark/Feishu docs. Each row is one proposal — approve to apply, reject with a reason, or dismiss without action. Mirrors the &quot;approve doc edit &lt;id&gt;&quot; Lark commands one-to-one.
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
        {STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            style={{
              padding: "6px 14px",
              fontSize: 12,
              borderRadius: 6,
              border: status === s ? "1px solid #1e293b" : "1px solid #e2e8f0",
              background: status === s ? "#1e293b" : "white",
              color: status === s ? "white" : "#475569",
              cursor: "pointer",
              fontWeight: status === s ? 600 : 500,
            }}
          >
            {s}
          </button>
        ))}
      </div>

      {msg && (
        <div style={{ marginBottom: 14, padding: "8px 12px", fontSize: 13, background: msg.startsWith("Failed") ? "#fef2f2" : "#ecfdf5", color: msg.startsWith("Failed") ? "#b91c1c" : "#065f46", borderRadius: 6 }}>
          {msg}
        </div>
      )}

      {loading ? (
        <div className="p-12 text-center"><Loader2 className="inline h-5 w-5 animate-spin" /></div>
      ) : proposals.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", color: "#94a3b8", fontSize: 14 }}>
          No proposals with status <code>{status}</code>.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {proposals.map((p) => (
            <div key={p.id} style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: 8, padding: 18 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "#1f2937", marginBottom: 4 }}>
                    {p.document_title ?? "(untitled doc)"}
                  </div>
                  <a href={p.document_url} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: "#3b82f6", display: "inline-flex", alignItems: "center", gap: 3 }}>
                    Open in Lark <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
                <div style={{ fontSize: 11, color: "#94a3b8", fontFamily: "monospace" }}>
                  {p.id.slice(0, 8)} · {new Date(p.created_at).toLocaleString()}
                </div>
              </div>

              <div style={{ fontSize: 13, color: "#1f2937", marginBottom: 8 }}>
                <span style={{ fontWeight: 600 }}>Summary:</span> {p.summary}
              </div>

              {p.narration && (
                <div style={{ fontSize: 12, color: "#475569", marginBottom: 10, padding: "8px 10px", background: "#f8fafc", borderLeft: "3px solid #cbd5e1", borderRadius: 4 }}>
                  <span style={{ fontWeight: 600, color: "#334155" }}>Leon&apos;s narration:</span> {p.narration}
                </div>
              )}

              <details style={{ marginBottom: 10 }}>
                <summary style={{ fontSize: 12, color: "#64748b", cursor: "pointer", userSelect: "none" }}>
                  {p.edits.length} edit{p.edits.length === 1 ? "" : "s"} (click to inspect)
                </summary>
                <pre style={{ fontSize: 11, fontFamily: "monospace", padding: "8px 10px", background: "#fafafa", border: "1px solid #e5e7eb", borderRadius: 4, marginTop: 6, maxHeight: 300, overflow: "auto" }}>
                  {JSON.stringify(p.edits, null, 2)}
                </pre>
              </details>

              {p.apply_error && (
                <div style={{ fontSize: 12, padding: "8px 10px", background: "#fef2f2", color: "#b91c1c", borderRadius: 4, marginBottom: 10 }}>
                  Apply error: {p.apply_error}
                </div>
              )}

              {p.decision_note && (
                <div style={{ fontSize: 12, padding: "6px 10px", background: "#fef3c7", color: "#78350f", borderRadius: 4, marginBottom: 10 }}>
                  Note: {p.decision_note}
                </div>
              )}

              <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, color: "#64748b" }}>
                <span>Status: <strong style={{ color: p.status === "applied" ? "#065f46" : p.status === "rejected" ? "#b91c1c" : "#0369a1" }}>{p.status}</strong></span>
                {p.proposed_by_name && <span>· by {p.proposed_by_name}</span>}
                {p.applied_at && <span>· applied {new Date(p.applied_at).toLocaleString()}</span>}

                {p.status === "pending" && (
                  <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                    <button
                      onClick={() => void act(p.id, "approve")}
                      disabled={busy === p.id}
                      style={{ fontSize: 12, padding: "5px 12px", borderRadius: 5, background: "#059669", color: "white", border: "none", cursor: "pointer", opacity: busy === p.id ? 0.5 : 1, display: "inline-flex", alignItems: "center", gap: 4 }}
                    >
                      <Check className="h-3 w-3" /> Approve + apply
                    </button>
                    <button
                      onClick={() => void act(p.id, "reject")}
                      disabled={busy === p.id}
                      style={{ fontSize: 12, padding: "5px 12px", borderRadius: 5, background: "#fef2f2", color: "#b91c1c", border: "1px solid #fecaca", cursor: "pointer", opacity: busy === p.id ? 0.5 : 1, display: "inline-flex", alignItems: "center", gap: 4 }}
                    >
                      <X className="h-3 w-3" /> Reject
                    </button>
                    <button
                      onClick={() => void act(p.id, "dismiss")}
                      disabled={busy === p.id}
                      style={{ fontSize: 11, padding: "5px 10px", borderRadius: 5, background: "transparent", color: "#94a3b8", border: "1px solid #e2e8f0", cursor: "pointer", opacity: busy === p.id ? 0.5 : 1, display: "inline-flex", alignItems: "center", gap: 4 }}
                    >
                      <Trash2 className="h-3 w-3" /> Dismiss
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
