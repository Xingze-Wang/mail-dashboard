"use client";

/**
 * Voice Templates — admin-only. Review + activate per-rep email
 * templates produced by the helper's `build_rep_template` action.
 *
 * A row becomes visible here as soon as `build_rep_template` runs
 * (inactive by default). The admin reads what the LLM produced,
 * optionally edits, and flips active = true. Draft assembly then
 * prefers this rep's template over the global one.
 *
 * Also shows the "global" template for direct edit — the one place
 * to actually change what *every* rep's emails look like.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Check, X, Trash2, Save, ChevronDown, ChevronRight, Sparkles } from "lucide-react";

interface EmailTemplate {
  id: string;
  name: string;
  rep_id: number | null;
  rep_name: string | null;
  active: boolean;
  subject_format: string;
  intro_prompt: string;
  greeting_format: string;
  rep_intro_format: string;
  school_pitch_format: string;
  cta_signoff_format: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export default function VoiceTemplatesPage() {
  const router = useRouter();
  const [gated, setGated] = useState<"checking" | "allowed" | "forbidden">("checking");
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Admin gate — mirror other admin-only pages (drift, bench).
  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        if (d.authenticated && d.role === "admin") setGated("allowed");
        else { setGated("forbidden"); router.replace("/"); }
      })
      .catch(() => { setGated("forbidden"); router.replace("/"); });
  }, [router]);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch("/api/email-templates", { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Failed");
      setTemplates(d.templates ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (gated !== "allowed") return;
    load();
  }, [gated, load]);

  const patch = async (id: string, updates: Partial<EmailTemplate>) => {
    setSaving(id);
    try {
      const r = await fetch("/api/email-templates", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...updates }),
      });
      const d = await r.json();
      if (!r.ok) setErr(d.error ?? "Update failed");
      else await load();
    } finally {
      setSaving(null);
    }
  };

  const remove = async (id: string, name: string) => {
    if (!confirm(`Delete template "${name}"? This cannot be undone.`)) return;
    setSaving(id);
    try {
      const r = await fetch(`/api/email-templates?id=${id}`, { method: "DELETE" });
      const d = await r.json();
      if (!r.ok) setErr(d.error ?? "Delete failed");
      else await load();
    } finally {
      setSaving(null);
    }
  };

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  if (gated === "checking") return null;
  if (gated === "forbidden") return null;

  const globalTpl = templates.find((t) => t.name === "global");
  const perRep = templates.filter((t) => t.name !== "global");

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h1 className="page-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Sparkles className="h-6 w-6" />
            Voice Templates
          </h1>
          <p style={{ color: "var(--muted)", marginTop: 6, fontSize: 13 }}>
            Per-rep email templates. Built from each rep&apos;s editing history via the helper&apos;s <code>build_rep_template</code> action. Inactive by default — flip <code>active</code> to roll out to that rep&apos;s drafts.
          </p>
        </div>
      </div>

      {err && (
        <div style={{ padding: "10px 14px", border: "1px solid #FECACA", background: "#FEF2F2", borderRadius: 8, color: "#991B1B", fontSize: 13, marginBottom: 16 }}>
          {err}
        </div>
      )}

      {loading ? (
        <div className="skeleton" style={{ height: 200 }} />
      ) : (
        <>
          {globalTpl && (
            <section style={{ marginBottom: 28 }}>
              <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 10, color: "var(--fg)", textTransform: "uppercase", letterSpacing: 0.5 }}>
                Global (default)
              </h2>
              <TemplateCard
                template={globalTpl}
                expanded={expanded.has(globalTpl.id)}
                saving={saving === globalTpl.id}
                canDelete={false}
                onToggleExpanded={() => toggleExpanded(globalTpl.id)}
                onToggleActive={() => patch(globalTpl.id, { active: !globalTpl.active })}
                onSave={(updates) => patch(globalTpl.id, updates)}
                onDelete={() => {/* unreachable */}}
              />
            </section>
          )}

          <section>
            <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 10, color: "var(--fg)", textTransform: "uppercase", letterSpacing: 0.5 }}>
              Per-rep ({perRep.length})
            </h2>
            {perRep.length === 0 ? (
              <div style={{ padding: 20, border: "1px dashed var(--border)", borderRadius: 8, color: "var(--muted)", fontSize: 13 }}>
                No per-rep templates yet. When a rep edits drafts heavily (≥5 in 7d), the helper offers to build one. Admin reviews here and activates.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {perRep.map((t) => (
                  <TemplateCard
                    key={t.id}
                    template={t}
                    expanded={expanded.has(t.id)}
                    saving={saving === t.id}
                    canDelete={true}
                    onToggleExpanded={() => toggleExpanded(t.id)}
                    onToggleActive={() => patch(t.id, { active: !t.active })}
                    onSave={(updates) => patch(t.id, updates)}
                    onDelete={() => remove(t.id, t.name)}
                  />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function TemplateCard({
  template,
  expanded,
  saving,
  canDelete,
  onToggleExpanded,
  onToggleActive,
  onSave,
  onDelete,
}: {
  template: EmailTemplate;
  expanded: boolean;
  saving: boolean;
  canDelete: boolean;
  onToggleExpanded: () => void;
  onToggleActive: () => void;
  onSave: (updates: Partial<EmailTemplate>) => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState({
    subject_format: template.subject_format,
    greeting_format: template.greeting_format,
    rep_intro_format: template.rep_intro_format,
    school_pitch_format: template.school_pitch_format,
    cta_signoff_format: template.cta_signoff_format,
  });
  const dirty =
    draft.subject_format !== template.subject_format ||
    draft.greeting_format !== template.greeting_format ||
    draft.rep_intro_format !== template.rep_intro_format ||
    draft.school_pitch_format !== template.school_pitch_format ||
    draft.cta_signoff_format !== template.cta_signoff_format;

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 10, background: "var(--card)", overflow: "hidden" }}>
      <div style={{ padding: 14, display: "flex", alignItems: "center", gap: 10 }}>
        <button
          onClick={onToggleExpanded}
          style={{ background: "transparent", border: 0, color: "var(--muted)", cursor: "pointer", padding: 2, lineHeight: 0 }}
        >
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--fg)" }}>{template.name}</span>
            {template.active ? (
              <span style={{ fontSize: 10.5, padding: "2px 6px", borderRadius: 4, background: "#16a34a22", color: "#16a34a", fontWeight: 600 }}>
                active
              </span>
            ) : (
              <span style={{ fontSize: 10.5, padding: "2px 6px", borderRadius: 4, background: "var(--border)", color: "var(--muted)", fontWeight: 600 }}>
                inactive
              </span>
            )}
            {template.rep_id !== null && (
              <span style={{ fontSize: 11, color: "var(--muted)" }}>{template.rep_name ?? `rep #${template.rep_id}`}</span>
            )}
          </div>
          {template.notes && (
            <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {template.notes}
            </div>
          )}
        </div>
        <button
          onClick={onToggleActive}
          disabled={saving}
          className="btn"
          style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12 }}
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : template.active ? <X className="h-3 w-3" /> : <Check className="h-3 w-3" />}
          {template.active ? "Deactivate" : "Activate"}
        </button>
        {canDelete && (
          <button
            onClick={onDelete}
            disabled={saving}
            className="btn"
            style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: "#dc2626" }}
          >
            <Trash2 className="h-3 w-3" />
            Delete
          </button>
        )}
      </div>

      {expanded && (
        <div style={{ padding: "14px 14px 14px 36px", borderTop: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 12 }}>
          <FormField label="Subject format" value={draft.subject_format} onChange={(v) => setDraft({ ...draft, subject_format: v })} rows={1} />
          <FormField label="Greeting format" value={draft.greeting_format} onChange={(v) => setDraft({ ...draft, greeting_format: v })} rows={1} />
          <FormField label="Rep intro" value={draft.rep_intro_format} onChange={(v) => setDraft({ ...draft, rep_intro_format: v })} rows={3} />
          <FormField label="School/compute pitch" value={draft.school_pitch_format} onChange={(v) => setDraft({ ...draft, school_pitch_format: v })} rows={3} />
          <FormField label="CTA + signoff" value={draft.cta_signoff_format} onChange={(v) => setDraft({ ...draft, cta_signoff_format: v })} rows={2} />
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              onClick={() => onSave(draft)}
              disabled={!dirty || saving}
              className="btn primary"
              style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12 }}
            >
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
              Save changes
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function FormField({ label, value, onChange, rows }: { label: string; value: string; onChange: (v: string) => void; rows: number }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>
        {label}
      </span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        style={{
          padding: "8px 10px",
          fontSize: 13,
          fontFamily: "var(--font-mono, ui-monospace, monospace)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          background: "var(--bg)",
          color: "var(--fg)",
          resize: "vertical",
        }}
      />
    </label>
  );
}
