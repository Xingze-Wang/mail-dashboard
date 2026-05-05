// /mapping — mailbox view for mapping team members.
// Mirrors /pipeline's vocabulary (page-title, section-card, dx-chip)
// since mapping people work like sales reps with one extra step:
// every draft requires explicit approval before it ships.
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, CheckCircle2, XCircle, Edit3 } from "lucide-react";
import { sanitizeHtml } from "@/lib/sanitize";

interface Target {
  id: string;
  label: string;
  spec: Record<string, unknown>;
  candidate_active: boolean;
  active: boolean;
  created_at: string;
}

interface Draft {
  id: string;
  target_id: string;
  lead_id: string;
  subject: string;
  body_html: string;
  match_reason: string | null;
  created_at: string;
  target?: { label: string };
  lead?: { author_name: string | null; author_email: string; title: string | null };
}

export default function MappingPage() {
  const router = useRouter();
  const [me, setMe] = useState<{ repId: number; repName: string; role: string } | null>(null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editSubject, setEditSubject] = useState("");
  const [editBody, setEditBody] = useState("");

  const refresh = () => {
    setLoading(true);
    Promise.all([
      fetch("/api/auth/me").then((r) => r.json()).then((m) => {
        if (!m.authenticated) { router.replace("/login?next=/mapping"); return null; }
        setMe({ repId: m.repId, repName: m.repName, role: m.role });
        return m;
      }),
      fetch("/api/mapping/targets").then((r) => r.ok ? r.json() : { targets: [] }),
      fetch("/api/mapping/drafts").then((r) => r.ok ? r.json() : { drafts: [] }),
    ])
      .then(([m, t, d]) => {
        if (!m) return;
        setTargets(t.targets ?? []);
        setDrafts(d.drafts ?? []);
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(refresh, [router]);

  const decide = async (draftId: string, decision: "approve" | "reject" | "edit_and_approve", payload: Record<string, string> = {}) => {
    setActing(draftId);
    try {
      const r = await fetch("/api/mapping/drafts/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draft_id: draftId, decision, ...payload }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        alert(`Failed: ${e.error || r.statusText}`);
      } else {
        setEditingId(null);
        refresh();
      }
    } finally {
      setActing(null);
    }
  };

  const startEdit = (d: Draft) => {
    setEditingId(d.id);
    setEditSubject(d.subject);
    setEditBody(d.body_html);
  };

  if (loading && drafts.length === 0 && targets.length === 0) {
    return <div style={{ padding: 48, textAlign: "center", color: "var(--text-tertiary)" }}><Loader2 className="h-5 w-5 animate-spin" style={{ display: "inline-block" }} /></div>;
  }

  if (err) {
    return <div style={{ padding: 24, fontSize: 13, color: "var(--coral)" }}>Failed to load: {err}</div>;
  }

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 className="page-title">Mapping mailbox</h1>
          <p style={{ fontSize: 13, color: "var(--text-tertiary)", marginTop: 4 }}>
            {me?.repName ? `${me.repName} · ` : ""}{drafts.length === 0 ? "no drafts pending" : `${drafts.length} draft${drafts.length === 1 ? "" : "s"} waiting for your approval`}
          </p>
        </div>
      </div>

      {/* Targets strip */}
      {targets.length > 0 && (
        <Section title="Your targets" count={targets.length}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {targets.map((t) => (
              <span key={t.id} className="dx-chip" style={{ fontSize: 12, cursor: "default" }}>
                {t.label}
                {t.candidate_active && <span style={{ marginLeft: 6, color: "var(--gold)", fontSize: 10 }}>● A/B</span>}
              </span>
            ))}
          </div>
        </Section>
      )}

      {/* Pending drafts */}
      <Section title="Pending drafts" count={drafts.length}>
        {drafts.length === 0 ? (
          <div className="section-card" style={{ padding: "24px 16px", textAlign: "center", fontSize: 13, color: "var(--text-tertiary)" }}>
            No drafts pending. Tell the bot to draft for one of your targets.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {drafts.map((d) => (
              <DraftCard
                key={d.id}
                d={d}
                acting={acting === d.id}
                editing={editingId === d.id}
                editSubject={editSubject}
                editBody={editBody}
                onEditSubject={setEditSubject}
                onEditBody={setEditBody}
                onStartEdit={() => startEdit(d)}
                onCancelEdit={() => setEditingId(null)}
                onApprove={() => decide(d.id, "approve")}
                onApproveEdited={() => decide(d.id, "edit_and_approve", { edited_subject: editSubject, edited_body_html: editBody })}
                onReject={() => {
                  const reason = prompt("Reject reason?");
                  if (reason !== null) decide(d.id, "reject", { reject_reason: reason });
                }}
              />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
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

function DraftCard({ d, acting, editing, editSubject, editBody, onEditSubject, onEditBody, onStartEdit, onCancelEdit, onApprove, onApproveEdited, onReject }: {
  d: Draft;
  acting: boolean;
  editing: boolean;
  editSubject: string;
  editBody: string;
  onEditSubject: (v: string) => void;
  onEditBody: (v: string) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onApprove: () => void;
  onApproveEdited: () => void;
  onReject: () => void;
}) {
  // Body comes from an LLM draft → sanitize before render. Same pattern
  // as /emails detail view (uses sanitizeHtml from lib/sanitize.ts).
  const safeBody = sanitizeHtml(d.body_html);
  return (
    <div className="section-card" style={{ padding: "16px 18px" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8, fontSize: 12 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>
          {d.target?.label ?? "(unknown target)"}
        </span>
        <span style={{ color: "var(--text-tertiary)" }}>→</span>
        <span style={{ color: "var(--text-secondary)" }}>
          {d.lead?.author_name ?? "(unknown)"} <code style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, color: "var(--text-tertiary)" }}>{d.lead?.author_email ?? ""}</code>
        </span>
        <span style={{ marginLeft: "auto", color: "var(--text-tertiary)" }}>{new Date(d.created_at).toLocaleString()}</span>
      </div>

      {/* Match reason */}
      {d.match_reason && (
        <p style={{ margin: "0 0 10px", fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic" }}>
          Matched because: {d.match_reason}
        </p>
      )}

      {editing ? (
        <>
          <input
            type="text"
            value={editSubject}
            onChange={(e) => onEditSubject(e.target.value)}
            style={{ width: "100%", marginBottom: 8, padding: "6px 8px", fontSize: 13, fontWeight: 600, border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg)", color: "var(--text)" }}
          />
          <textarea
            value={editBody}
            onChange={(e) => onEditBody(e.target.value)}
            rows={10}
            style={{ width: "100%", marginBottom: 12, padding: "8px 10px", fontSize: 13, fontFamily: "ui-monospace, monospace", border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg)", color: "var(--text)" }}
          />
        </>
      ) : (
        <>
          <div style={{ marginBottom: 10, fontSize: 14, fontWeight: 600 }}>{d.subject}</div>
          <div
            style={{ marginBottom: 12, fontSize: 13, lineHeight: 1.6, color: "var(--text-secondary)" }}
            dangerouslySetInnerHTML={{ __html: safeBody }}
          />
        </>
      )}

      {/* Actions */}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {editing ? (
          <>
            <button onClick={onApproveEdited} disabled={acting} className="btn btn-primary" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <CheckCircle2 className="h-3 w-3" /> Save & approve
            </button>
            <button onClick={onCancelEdit} disabled={acting} className="btn">Cancel</button>
          </>
        ) : (
          <>
            <button onClick={onApprove} disabled={acting} className="btn btn-primary" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              {acting ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
              Approve as-is
            </button>
            <button onClick={onStartEdit} disabled={acting} className="btn" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <Edit3 className="h-3 w-3" /> Edit
            </button>
            <button onClick={onReject} disabled={acting} className="btn" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <XCircle className="h-3 w-3" /> Reject
            </button>
          </>
        )}
      </div>
    </div>
  );
}
