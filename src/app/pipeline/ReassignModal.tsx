"use client";

/**
 * Admin re-assignment modal. Three modes in one panel so the
 * full-batch hammer ("auto-route everything") and the precision
 * tools (filter + rules) live next to each other.
 *
 * Modes:
 *   - Auto-route — re-runs the live AssignmentConfig over every lead.
 *     Same behavior as the old top-bar button.
 *   - Bulk move — pick a target rep + a filter (current rep / lead
 *     tier / status). Preview first; apply moves both
 *     pipeline_leads.assigned_rep_id and emails.rep_id (owner mirror).
 *   - Rules — declarative ordered rules: when {geo, schoolTier,
 *     leadTier, currentRepId} → toRep. Preview shows per-rule match
 *     counts + samples. Apply persists.
 */

import { useState } from "react";
import { Loader2, X, Plus, Trash2, Wand2 } from "lucide-react";

interface Rep { id: number; name: string }

type Mode = "auto" | "bulk" | "rules";

interface Toast {
  (opts: { variant: "success" | "error" | "info"; title: string; description?: string }): void;
}

export function ReassignModal({
  reps,
  onClose,
  onAutoRouteAll,
  onSuccess,
  toast,
}: {
  reps: Rep[];
  onClose: () => void;
  onAutoRouteAll: () => Promise<void>;
  onSuccess: () => void;
  toast: Toast;
}) {
  const [mode, setMode] = useState<Mode>("bulk");
  const [busy, setBusy] = useState(false);

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "min(720px, 100%)", maxHeight: "90vh", overflow: "auto", background: "var(--card, #fff)", borderRadius: 12, padding: 20 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <h3 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Re-assign leads</h3>
          <button onClick={onClose} className="dx-secondary" style={{ padding: 4 }}>
            <X className="h-4 w-4" />
          </button>
        </div>

        <div style={{ display: "flex", gap: 6, marginBottom: 16, borderBottom: "1px solid var(--border, #e5e7eb)" }}>
          {(["bulk", "rules", "auto"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              style={{
                padding: "6px 12px",
                fontSize: 13,
                fontWeight: mode === m ? 600 : 400,
                background: "transparent",
                border: "none",
                borderBottom: "2px solid " + (mode === m ? "var(--text, #111827)" : "transparent"),
                color: mode === m ? "var(--text, #111827)" : "var(--text-tertiary, #9ca3af)",
                cursor: "pointer",
                marginBottom: -1,
              }}
            >
              {m === "bulk" ? "Bulk move" : m === "rules" ? "Rules" : "Auto-route all"}
            </button>
          ))}
        </div>

        {mode === "auto" && (
          <AutoRoutePanel
            busy={busy}
            setBusy={setBusy}
            onAutoRouteAll={onAutoRouteAll}
            onClose={onClose}
            onSuccess={onSuccess}
          />
        )}
        {mode === "bulk" && <BulkMovePanel reps={reps} toast={toast} onSuccess={onSuccess} onClose={onClose} />}
        {mode === "rules" && <RulesPanel reps={reps} toast={toast} onSuccess={onSuccess} onClose={onClose} />}
      </div>
    </div>
  );
}

/* ─────────────── Auto-route ──────────────── */

function AutoRoutePanel({
  busy,
  setBusy,
  onAutoRouteAll,
  onClose,
  onSuccess,
}: {
  busy: boolean;
  setBusy: (b: boolean) => void;
  onAutoRouteAll: () => Promise<void>;
  onClose: () => void;
  onSuccess: () => void;
}) {
  return (
    <div>
      <p style={{ fontSize: 13, color: "var(--text-secondary, #4b5563)", marginBottom: 14 }}>
        Re-runs the live <code>AssignmentConfig</code> across <strong>every</strong> lead. Same logic as new-lead routing — strong leads to seniors, normal to round-robin, etc. Use this after editing config or when bulk drift needs a reset.
      </p>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button onClick={onClose} className="dx-secondary" disabled={busy}>Cancel</button>
        <button
          onClick={async () => {
            setBusy(true);
            try {
              await onAutoRouteAll();
              onSuccess();
              onClose();
            } finally {
              setBusy(false);
            }
          }}
          disabled={busy}
          className="dx-primary"
          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}
          {busy ? "Routing…" : "Re-route everything"}
        </button>
      </div>
    </div>
  );
}

/* ─────────────── Bulk move ──────────────── */

function BulkMovePanel({
  reps,
  toast,
  onSuccess,
  onClose,
}: {
  reps: Rep[];
  toast: Toast;
  onSuccess: () => void;
  onClose: () => void;
}) {
  const [toRepId, setToRepId] = useState<number | null>(null);
  const [currentRepId, setCurrentRepId] = useState<number | "" | "null">("");
  const [leadTier, setLeadTier] = useState<"" | "strong" | "normal">("");
  const [status, setStatus] = useState("");
  const [preview, setPreview] = useState<{ wouldReassign: number; sample: { id: string; title: string | null; author_name: string | null; fromRepId: number | null }[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const filter = () => {
    const f: Record<string, unknown> = {};
    if (currentRepId === "null") f.currentRepId = null;
    else if (typeof currentRepId === "number") f.currentRepId = currentRepId;
    if (leadTier) f.leadTier = leadTier;
    if (status) f.status = status;
    return f;
  };

  const doPreview = async () => {
    if (toRepId == null) return;
    setBusy(true);
    try {
      const r = await fetch("/api/admin/reassign-leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "preview", toRepId, filter: filter() }),
      });
      const d = await r.json();
      if (!r.ok) {
        toast({ variant: "error", title: "Preview failed", description: d.error });
        return;
      }
      setPreview(d);
    } finally {
      setBusy(false);
    }
  };

  const doApply = async () => {
    if (toRepId == null) return;
    if (!confirm(`Move ${preview?.wouldReassign ?? "?"} leads to the selected rep? Emails will follow.`)) return;
    setBusy(true);
    try {
      const r = await fetch("/api/admin/reassign-leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "filter", toRepId, filter: filter() }),
      });
      const d = await r.json();
      if (!r.ok) {
        toast({ variant: "error", title: "Re-assign failed", description: d.error });
        return;
      }
      toast({ variant: "success", title: `Re-assigned ${d.reassigned} leads`, description: `${d.emailsCascaded} emails cascaded` });
      onSuccess();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  // Why the Apply button might be disabled — surfaced as a tooltip
  // and inline hint so "I clicked and nothing happened" never
  // happens again. Order matches the disabled= predicate so the
  // first true reason wins.
  const applyHint =
    toRepId == null ? "Pick a target rep first."
      : !preview ? "Click Preview before Apply."
      : preview.wouldReassign === 0 ? "No leads match this filter — nothing to apply."
      : "";
  const previewHint = toRepId == null ? "Pick a target rep first." : "";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <p style={{ fontSize: 13, color: "var(--text-secondary, #4b5563)", margin: 0 }}>
        Move all leads matching a filter to one rep. <strong>Pick a rep, hit Preview, then Apply.</strong>
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label="Target rep">
          <select value={toRepId ?? ""} onChange={(e) => setToRepId(e.target.value ? Number(e.target.value) : null)} className="dx-select-light">
            <option value="">— pick a rep —</option>
            {reps.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </Field>
        <Field label="Currently assigned to">
          <select
            value={currentRepId === "" ? "" : currentRepId === "null" ? "null" : String(currentRepId)}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "") setCurrentRepId("");
              else if (v === "null") setCurrentRepId("null");
              else setCurrentRepId(Number(v));
            }}
            className="dx-select-light"
          >
            <option value="">any</option>
            <option value="null">unassigned</option>
            {reps.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </Field>
        <Field label="Lead tier">
          <select value={leadTier} onChange={(e) => setLeadTier(e.target.value as "" | "strong" | "normal")} className="dx-select-light">
            <option value="">any</option>
            <option value="strong">strong</option>
            <option value="normal">normal</option>
          </select>
        </Field>
        <Field label="Status">
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="dx-select-light">
            <option value="">any</option>
            <option value="ready">ready</option>
            <option value="sent">sent</option>
            <option value="replied">replied</option>
            <option value="skipped">skipped</option>
          </select>
        </Field>
      </div>

      {preview && (
        <div style={{ padding: 12, border: "1px solid var(--border, #e5e7eb)", borderRadius: 8, background: "var(--bg-subtle, #fafafa)" }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
            {preview.wouldReassign === 0
              ? "No leads match this filter."
              : `Will re-assign ${preview.wouldReassign} lead${preview.wouldReassign === 1 ? "" : "s"}.`}
          </div>
          {preview.wouldReassign === 0 && (
            <div style={{ fontSize: 12, color: "var(--text-secondary, #4b5563)" }}>
              Loosen the filter (e.g. set Status to <em>any</em>) or pick a different target rep.
            </div>
          )}
          {preview.sample.length > 0 && (
            <div style={{ fontSize: 12, color: "var(--text-secondary, #4b5563)" }}>
              Sample:
              <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
                {preview.sample.map((s) => (
                  <li key={s.id}>{s.author_name ?? s.id.slice(0, 8)} — {(s.title ?? "").slice(0, 60)}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {(applyHint || previewHint) && !busy && (
        <div style={{ fontSize: 12, color: "var(--text-tertiary, #9ca3af)", textAlign: "right" }}>
          {applyHint || previewHint}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button onClick={onClose} className="dx-secondary" disabled={busy}>Cancel</button>
        <button
          onClick={doPreview}
          disabled={busy || toRepId == null}
          title={previewHint || "Preview which leads will be re-assigned"}
          className="dx-secondary"
        >
          {busy && !preview ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          Preview
        </button>
        <button
          onClick={doApply}
          disabled={busy || toRepId == null || !preview || preview.wouldReassign === 0}
          title={applyHint || "Apply this re-assignment"}
          className="dx-primary"
        >
          {busy && preview ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          Apply
        </button>
      </div>
    </div>
  );
}

/* ─────────────── Rules ──────────────── */

interface RuleDraft {
  geo: "" | "cn" | "edu" | "other";
  schoolTier: "" | "1" | "2" | "3";
  leadTier: "" | "strong" | "normal";
  currentRepId: number | "" | "null";
  toRepId: number | null;
}

function emptyRule(): RuleDraft {
  return { geo: "", schoolTier: "", leadTier: "", currentRepId: "", toRepId: null };
}

function ruleToWire(r: RuleDraft) {
  const when: Record<string, unknown> = {};
  if (r.geo) when.geo = r.geo;
  if (r.schoolTier) when.schoolTier = Number(r.schoolTier);
  if (r.leadTier) when.leadTier = r.leadTier;
  if (r.currentRepId === "null") when.currentRepId = null;
  else if (typeof r.currentRepId === "number") when.currentRepId = r.currentRepId;
  return { when, toRepId: r.toRepId };
}

interface RulePreview {
  totalLeads: number;
  unmatched: number;
  perRule: { index: number; toRepId: number; toRepName: string; matchCount: number; sample: { id: string; title: string | null; author_name: string | null }[] }[];
}

function RulesPanel({
  reps,
  toast,
  onSuccess,
  onClose,
}: {
  reps: Rep[];
  toast: Toast;
  onSuccess: () => void;
  onClose: () => void;
}) {
  const [drafts, setDrafts] = useState<RuleDraft[]>([emptyRule()]);
  const [preview, setPreview] = useState<RulePreview | null>(null);
  const [busy, setBusy] = useState(false);

  const update = (i: number, patch: Partial<RuleDraft>) => {
    setDrafts((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
    setPreview(null);
  };
  const remove = (i: number) => {
    setDrafts((prev) => prev.filter((_, idx) => idx !== i));
    setPreview(null);
  };
  const add = () => setDrafts((prev) => [...prev, emptyRule()]);

  const validate = (): { ok: true; rules: ReturnType<typeof ruleToWire>[] } | { ok: false; err: string } => {
    if (drafts.length === 0) return { ok: false, err: "add at least one rule" };
    const rules = drafts.map(ruleToWire);
    for (let i = 0; i < rules.length; i++) {
      if (rules[i].toRepId == null) return { ok: false, err: `rule ${i + 1}: pick a target rep` };
      if (Object.keys(rules[i].when).length === 0) return { ok: false, err: `rule ${i + 1}: add at least one condition` };
    }
    return { ok: true, rules };
  };

  const doPreview = async () => {
    const v = validate();
    if (!v.ok) {
      toast({ variant: "error", title: "Invalid rules", description: v.err });
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/admin/reassign-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "preview", rules: v.rules }),
      });
      const d = await r.json();
      if (!r.ok) {
        toast({ variant: "error", title: "Preview failed", description: d.error });
        return;
      }
      setPreview(d);
    } finally {
      setBusy(false);
    }
  };

  const doApply = async () => {
    const v = validate();
    if (!v.ok) return;
    const total = preview?.perRule.reduce((s, r) => s + r.matchCount, 0) ?? 0;
    if (!confirm(`Apply ${drafts.length} rules → re-assign ${total} leads? Emails will follow.`)) return;
    setBusy(true);
    try {
      const r = await fetch("/api/admin/reassign-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "apply", rules: v.rules }),
      });
      const d = await r.json();
      if (!r.ok) {
        toast({ variant: "error", title: "Apply failed", description: d.error });
        return;
      }
      toast({ variant: "success", title: `Re-assigned ${d.reassigned} leads`, description: `${d.emailsCascaded} emails cascaded` });
      onSuccess();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  // Why the Apply-rules button is disabled — same idea as bulk move:
  // surface the reason so disabled buttons never feel like dead UI.
  const rulesApplyHint = !preview
    ? "Click Preview before Apply rules."
    : preview.perRule.reduce((s, r) => s + r.matchCount, 0) === 0
      ? "No leads match any rule — nothing to apply."
      : "";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <p style={{ fontSize: 13, color: "var(--text-secondary, #4b5563)", margin: 0 }}>
        Ordered rules. First match wins per lead. Conditions are AND-ed.
        <strong> Build rules, hit Preview, then Apply rules.</strong>
      </p>
      {drafts.map((r, i) => (
        <RuleRow key={i} idx={i} draft={r} reps={reps} onChange={(p) => update(i, p)} onRemove={drafts.length > 1 ? () => remove(i) : null} />
      ))}
      <button onClick={add} className="dx-secondary" style={{ alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 4 }}>
        <Plus className="h-3 w-3" /> Add rule
      </button>

      {preview && (
        <div style={{ padding: 12, border: "1px solid var(--border, #e5e7eb)", borderRadius: 8, background: "var(--bg-subtle, #fafafa)", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            {preview.totalLeads} total leads · {preview.perRule.reduce((s, r) => s + r.matchCount, 0)} matched · {preview.unmatched} unmatched
          </div>
          {preview.perRule.map((r) => (
            <div key={r.index} style={{ fontSize: 12, color: "var(--text-secondary, #4b5563)", paddingLeft: 4 }}>
              <strong style={{ color: "var(--text, #111827)" }}>Rule {r.index + 1} → {r.toRepName}:</strong> {r.matchCount} match{r.matchCount === 1 ? "" : "es"}
              {r.sample.length > 0 && (
                <span style={{ marginLeft: 6, fontSize: 11 }}>
                  e.g. {r.sample.slice(0, 2).map((s) => s.author_name ?? s.id.slice(0, 8)).join(", ")}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {rulesApplyHint && !busy && (
        <div style={{ fontSize: 12, color: "var(--text-tertiary, #9ca3af)", textAlign: "right" }}>
          {rulesApplyHint}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button onClick={onClose} className="dx-secondary" disabled={busy}>Cancel</button>
        <button
          onClick={doPreview}
          disabled={busy}
          title="Preview how many leads each rule will match"
          className="dx-secondary"
        >
          {busy && !preview ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          Preview
        </button>
        <button
          onClick={doApply}
          disabled={busy || !preview || preview.perRule.reduce((s, r) => s + r.matchCount, 0) === 0}
          title={rulesApplyHint || "Apply all rules"}
          className="dx-primary"
        >
          {busy && preview ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          Apply rules
        </button>
      </div>
    </div>
  );
}

function RuleRow({ idx, draft, reps, onChange, onRemove }: { idx: number; draft: RuleDraft; reps: Rep[]; onChange: (p: Partial<RuleDraft>) => void; onRemove: (() => void) | null }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: 10, border: "1px solid var(--border, #e5e7eb)", borderRadius: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 11, color: "var(--text-tertiary, #9ca3af)", textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>
          Rule {idx + 1}
        </span>
        {onRemove && (
          <button onClick={onRemove} className="dx-secondary" style={{ padding: 4, color: "#dc2626" }}>
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
        <select className="dx-select-light" value={draft.geo} onChange={(e) => onChange({ geo: e.target.value as RuleDraft["geo"] })}>
          <option value="">geo: any</option>
          <option value="cn">geo: cn</option>
          <option value="edu">geo: edu</option>
          <option value="other">geo: other</option>
        </select>
        <select className="dx-select-light" value={draft.schoolTier} onChange={(e) => onChange({ schoolTier: e.target.value as RuleDraft["schoolTier"] })}>
          <option value="">tier: any</option>
          <option value="1">tier: 1</option>
          <option value="2">tier: 2</option>
          <option value="3">tier: 3</option>
        </select>
        <select className="dx-select-light" value={draft.leadTier} onChange={(e) => onChange({ leadTier: e.target.value as RuleDraft["leadTier"] })}>
          <option value="">leadTier: any</option>
          <option value="strong">strong</option>
          <option value="normal">normal</option>
        </select>
        <select
          className="dx-select-light"
          value={draft.currentRepId === "" ? "" : draft.currentRepId === "null" ? "null" : String(draft.currentRepId)}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "") onChange({ currentRepId: "" });
            else if (v === "null") onChange({ currentRepId: "null" });
            else onChange({ currentRepId: Number(v) });
          }}
        >
          <option value="">currently: any</option>
          <option value="null">unassigned</option>
          {reps.map((r) => <option key={r.id} value={r.id}>currently: {r.name}</option>)}
        </select>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12, color: "var(--text-secondary, #4b5563)" }}>→ assign to</span>
        <select className="dx-select-light" value={draft.toRepId ?? ""} onChange={(e) => onChange({ toRepId: e.target.value ? Number(e.target.value) : null })} style={{ flex: 1 }}>
          <option value="">— pick a rep —</option>
          {reps.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 11, color: "var(--text-tertiary, #9ca3af)", textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>{label}</span>
      {children}
    </label>
  );
}
