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
import { Loader2, Check, X, Trash2, Save, ChevronDown, ChevronRight, Sparkles, Eye, Wand2, History as HistoryIcon, RotateCcw } from "lucide-react";
import { sanitizeHtml } from "@/lib/sanitize";
import { MpSignalCounts } from "@/components/MpSignalPills";

interface TemplatePerf {
  id: string;
  sent: number;
  clicked: number;
  wechat: number;
  registered: number;
  submitted: number;
  clickRate: number;
  wechatRate: number;
  vsClickBaseline: number;
  vsWechatBaseline: number;
}
interface TemplateVersion {
  id: string;
  template_id: string;
  snapshot: Partial<EmailTemplate>;
  edited_by: string | null;
  edited_at: string;
  note: string | null;
}

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
  const [perf, setPerf] = useState<Record<string, TemplatePerf>>({});
  const [perfWindow, setPerfWindow] = useState(30);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [previewTpl, setPreviewTpl] = useState<EmailTemplate | null>(null);
  const [historyTpl, setHistoryTpl] = useState<EmailTemplate | null>(null);
  const [building, setBuilding] = useState<number | null>(null);
  const [buildResult, setBuildResult] = useState<{ rep: string; templateId?: string; note?: string } | null>(null);

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

  // Performance fetch — separate from templates load so toggling the
  // window doesn't refetch the template definitions. Quietly degrades
  // if the endpoint isn't available (e.g. before migration 032).
  useEffect(() => {
    if (gated !== "allowed") return;
    fetch(`/api/templates/performance?days=${perfWindow}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (d.error) return;
        const map: Record<string, TemplatePerf> = {};
        for (const t of d.templates ?? []) map[t.id] = t;
        setPerf(map);
      })
      .catch(() => {});
  }, [gated, perfWindow]);

  const buildFromEdits = async (repId: number, repName: string) => {
    setBuilding(repId);
    setBuildResult(null);
    try {
      const r = await fetch("/api/help/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proposal: { action: "build_rep_template", rep_id: repId } }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setBuildResult({ rep: repName, note: d.detail?.error ?? d.error ?? "Build failed" });
      } else {
        setBuildResult({ rep: repName, templateId: d.detail?.template_id, note: d.detail?.note ?? "Template built — review below." });
        await load();
      }
    } catch (e) {
      setBuildResult({ rep: repName, note: e instanceof Error ? e.message : "Network error" });
    } finally {
      setBuilding(null);
    }
  };

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
            Per-rep email templates. Built from each rep&apos;s editing history. Inactive by default — flip <code>active</code> to roll out to that rep&apos;s drafts. Performance chips show send / click / wechat over the window.
          </p>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ fontSize: 11, color: "var(--muted)" }}>Window:</span>
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              onClick={() => setPerfWindow(d)}
              style={{
                padding: "4px 10px",
                fontSize: 12,
                border: "1px solid " + (perfWindow === d ? "var(--fg)" : "var(--border)"),
                borderRadius: 6,
                background: perfWindow === d ? "var(--fg)" : "transparent",
                color: perfWindow === d ? "var(--card)" : "var(--text-secondary)",
                cursor: "pointer",
              }}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {buildResult && (
        <div style={{ padding: "10px 14px", border: "1px solid var(--border-light)", background: "var(--bg-subtle, #fafafa)", borderRadius: 8, fontSize: 13, marginBottom: 16, color: "var(--text-secondary)" }}>
          <strong>{buildResult.rep}:</strong> {buildResult.note}
        </div>
      )}

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
                perf={perf[globalTpl.id]}
                expanded={expanded.has(globalTpl.id)}
                saving={saving === globalTpl.id}
                canDelete={false}
                building={false}
                onToggleExpanded={() => toggleExpanded(globalTpl.id)}
                onToggleActive={() => patch(globalTpl.id, { active: !globalTpl.active })}
                onSave={(updates) => patch(globalTpl.id, updates)}
                onDelete={() => {/* unreachable */}}
                onPreview={() => setPreviewTpl(globalTpl)}
                onHistory={() => setHistoryTpl(globalTpl)}
                onBuild={null /* global has no rep — build button hidden */}
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
                    perf={perf[t.id]}
                    expanded={expanded.has(t.id)}
                    saving={saving === t.id}
                    canDelete={true}
                    building={building === t.rep_id}
                    onToggleExpanded={() => toggleExpanded(t.id)}
                    onToggleActive={() => patch(t.id, { active: !t.active })}
                    onSave={(updates) => patch(t.id, updates)}
                    onDelete={() => remove(t.id, t.name)}
                    onPreview={() => setPreviewTpl(t)}
                    onHistory={() => setHistoryTpl(t)}
                    onBuild={t.rep_id != null ? () => buildFromEdits(t.rep_id as number, t.rep_name ?? t.name) : null}
                  />
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {previewTpl && <PreviewModal template={previewTpl} onClose={() => setPreviewTpl(null)} />}
      {historyTpl && <HistoryModal template={historyTpl} onClose={() => setHistoryTpl(null)} onRestored={load} />}
    </div>
  );
}

function TemplateCard({
  template,
  perf,
  expanded,
  saving,
  canDelete,
  building,
  onToggleExpanded,
  onToggleActive,
  onSave,
  onDelete,
  onPreview,
  onHistory,
  onBuild,
}: {
  template: EmailTemplate;
  perf?: TemplatePerf;
  expanded: boolean;
  saving: boolean;
  canDelete: boolean;
  building: boolean;
  onToggleExpanded: () => void;
  onToggleActive: () => void;
  onSave: (updates: Partial<EmailTemplate>) => void;
  onDelete: () => void;
  onPreview: () => void;
  onHistory: () => void;
  onBuild: (() => void) | null;
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
            {perf && perf.sent > 0 && <PerfChip perf={perf} />}
          </div>
          {template.notes && (
            <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {template.notes}
            </div>
          )}
        </div>
        <button onClick={onPreview} className="btn" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12 }} title="Preview against a recent lead">
          <Eye className="h-3 w-3" />
          Preview
        </button>
        <button onClick={onHistory} className="btn" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12 }} title="Version history">
          <HistoryIcon className="h-3 w-3" />
          History
        </button>
        {onBuild && (
          <button onClick={onBuild} disabled={building} className="btn" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12 }} title="Build a new template from this rep's last 30 edited sends">
            {building ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}
            {building ? "Building…" : "Auto-build"}
          </button>
        )}
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
          <SegmentOverridesEditor templateId={template.id} />
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

/* ──────────────────────────── Performance chip ──────────────────────────── */

function PerfChip({ perf }: { perf: TemplatePerf }) {
  // Tone follows wechat lift vs baseline; muted if too few sends to
  // tell. The honest threshold for "this is real" is ~10 sends per
  // template — under that, show numbers but don't color the lift.
  const reliable = perf.sent >= 10;
  const liftTone =
    !reliable
      ? "var(--muted)"
      : perf.vsWechatBaseline >= 1.3
        ? "#16a34a"
        : perf.vsWechatBaseline <= 0.7
          ? "#dc2626"
          : "var(--text-secondary)";
  return (
    <span
      title={`Last window: ${perf.sent} sent · ${perf.clicked} click (${(perf.clickRate * 100).toFixed(1)}%) · ${perf.registered} 注册 · ${perf.submitted} 开表 · ${perf.wechat} 微信. vs baseline: ${perf.vsClickBaseline.toFixed(2)}x click, ${perf.vsWechatBaseline.toFixed(2)}x wechat.`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 10.5,
        padding: "2px 6px",
        borderRadius: 4,
        background: "var(--bg)",
        border: "1px solid var(--border-light)",
        color: liftTone,
        fontFamily: "var(--font-mono, ui-monospace, monospace)",
        fontWeight: 600,
      }}
    >
      <span>{perf.sent} sent</span>
      <span style={{ color: "var(--border, #e2e8f0)" }}>·</span>
      <MpSignalCounts
        size="sm"
        registered={perf.registered}
        submittedApplication={perf.submitted}
        addedWechat={perf.wechat}
        totalEmailed={perf.sent}
      />
      {reliable && perf.vsWechatBaseline !== 0 && (
        <span style={{ color: liftTone }}>
          · {perf.vsWechatBaseline >= 1 ? "+" : ""}{((perf.vsWechatBaseline - 1) * 100).toFixed(0)}%
        </span>
      )}
    </span>
  );
}

/* ──────────────────────────── Preview modal ──────────────────────────── */

interface RecentLead { id: string; title: string; author_name: string | null; author_email: string }

function PreviewModal({ template, onClose }: { template: EmailTemplate; onClose: () => void }) {
  const [leads, setLeads] = useState<RecentLead[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ subject: string; html: string; warning?: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch("/api/templates/preview/leads")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setErr(d.error);
        else {
          setLeads(d.leads ?? []);
          if (d.leads?.[0]) setSelectedId(d.leads[0].id);
        }
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    setGenerating(true);
    setErr(null);
    fetch(`/api/templates/preview?templateId=${template.id}&leadId=${selectedId}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setErr(d.error);
        else setDraft({ subject: d.subject, html: d.html, warning: d.warning ?? null });
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setGenerating(false));
  }, [selectedId, template.id]);

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "min(720px, 100%)", maxHeight: "90vh", overflow: "auto", background: "var(--card)", borderRadius: 12, padding: 20 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <h3 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Preview: {template.name}</h3>
          <button onClick={onClose} className="btn" style={{ padding: 4 }}>
            <X className="h-4 w-4" />
          </button>
        </div>
        {loading ? (
          <div className="skeleton" style={{ height: 200 }} />
        ) : err ? (
          <div style={{ fontSize: 13, color: "#dc2626" }}>{err}</div>
        ) : (
          <>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 14 }}>
              <span style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.4 }}>Lead (last 5 sent)</span>
              <select value={selectedId ?? ""} onChange={(e) => setSelectedId(e.target.value)} style={{ padding: "6px 10px", fontSize: 13, border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)" }}>
                {leads.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.author_name ?? l.author_email} — {(l.title ?? "").slice(0, 60)}
                  </option>
                ))}
              </select>
            </label>
            {generating ? (
              <div className="skeleton" style={{ height: 200 }} />
            ) : draft ? (
              <>
                {draft.warning && (
                  <div style={{ padding: "8px 12px", fontSize: 12, background: "#fef3c7", color: "#92400e", border: "1px solid #fde68a", borderRadius: 6, marginBottom: 12 }}>
                    Preview degraded: {draft.warning}
                  </div>
                )}
                <div style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>Subject</div>
                <div style={{ padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", fontSize: 13, marginBottom: 12, fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>
                  {draft.subject}
                </div>
                <div style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>Body</div>
                <div
                  style={{ padding: 14, border: "1px solid var(--border)", borderRadius: 6, background: "#fff", color: "#1a1a1a", fontSize: 13 }}
                  dangerouslySetInnerHTML={{ __html: sanitizeHtml(draft.html) }}
                />
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/* ──────────────────────────── History modal ──────────────────────────── */

function HistoryModal({ template, onClose, onRestored }: { template: EmailTemplate; onClose: () => void; onRestored: () => void }) {
  const [versions, setVersions] = useState<TemplateVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/email-templates/${template.id}/versions`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setErr(d.error);
        else setVersions(d.versions ?? []);
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, [template.id]);

  const restore = async (versionId: string) => {
    if (!confirm("Restore this version? Current settings will be saved as a new history entry first.")) return;
    setRestoring(versionId);
    try {
      const r = await fetch(`/api/email-templates/${template.id}/versions/${versionId}/restore`, { method: "POST" });
      const d = await r.json();
      if (!r.ok) setErr(d.error ?? "Restore failed");
      else {
        onRestored();
        onClose();
      }
    } finally {
      setRestoring(null);
    }
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "min(620px, 100%)", maxHeight: "90vh", overflow: "auto", background: "var(--card)", borderRadius: 12, padding: 20 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <h3 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>History: {template.name}</h3>
          <button onClick={onClose} className="btn" style={{ padding: 4 }}>
            <X className="h-4 w-4" />
          </button>
        </div>
        {loading ? (
          <div className="skeleton" style={{ height: 100 }} />
        ) : err ? (
          <div style={{ fontSize: 13, color: "#dc2626" }}>{err}</div>
        ) : versions.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--muted)" }}>No history yet — versions are saved on every edit going forward.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {versions.map((v, i) => {
              const next = versions[i - 1] ?? null;
              return (
                <div key={v.id} style={{ padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <div>
                      <strong>{new Date(v.edited_at).toLocaleString()}</strong>
                      {v.edited_by && <span style={{ marginLeft: 6, color: "var(--muted)" }}>by {v.edited_by}</span>}
                    </div>
                    <button onClick={() => restore(v.id)} disabled={restoring === v.id} className="btn" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11 }}>
                      {restoring === v.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                      Restore
                    </button>
                  </div>
                  {v.note && <div style={{ color: "var(--muted)", marginBottom: 4 }}>{v.note}</div>}
                  {next && <DiffSummary prev={v.snapshot} next={next.snapshot} />}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function DiffSummary({ prev, next }: { prev: Partial<EmailTemplate>; next: Partial<EmailTemplate> }) {
  const fields = ["subject_format", "greeting_format", "rep_intro_format", "school_pitch_format", "cta_signoff_format", "intro_prompt"] as const;
  const changed = fields.filter((f) => (prev[f] ?? "") !== (next[f] ?? ""));
  if (changed.length === 0) return null;
  return (
    <div style={{ color: "var(--text-secondary)", fontSize: 11, fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>
      Changed: {changed.map((c) => c.replace(/_format$/, "")).join(", ")}
    </div>
  );
}

/* ──────────────────────────── Segment overrides ──────────────────────────── */

const SLOT_OPTIONS = [
  { value: "subject_format", label: "Subject" },
  { value: "greeting_format", label: "Greeting" },
  { value: "rep_intro_format", label: "Rep intro" },
  { value: "school_pitch_format", label: "School/compute pitch" },
  { value: "cta_signoff_format", label: "CTA + signoff" },
  { value: "intro_prompt", label: "Intro prompt (LLM)" },
] as const;

interface OverrideRow {
  id: string;
  slot_name: string;
  when: Record<string, unknown>;
  value: string;
  notes: string | null;
  created_at: string;
}

function SegmentOverridesEditor({ templateId }: { templateId: string }) {
  const [overrides, setOverrides] = useState<OverrideRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<{ slot: string; geo: string; schoolTier: string; value: string }>({
    slot: "subject_format",
    geo: "",
    schoolTier: "",
    value: "",
  });
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/email-templates/overrides?templateId=${templateId}`);
      const d = await r.json();
      if (d.error) setErr(d.error);
      else setOverrides(d.overrides ?? []);
    } finally {
      setLoading(false);
    }
  }, [templateId]);

  useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (!draft.value.trim()) return;
    setAdding(true);
    setErr(null);
    try {
      const when: Record<string, unknown> = {};
      if (draft.geo) when.geo = draft.geo;
      if (draft.schoolTier) when.school_tier = Number(draft.schoolTier);
      const r = await fetch("/api/email-templates/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId, slotName: draft.slot, when, value: draft.value }),
      });
      const d = await r.json();
      if (!r.ok) setErr(d.error ?? "Add failed");
      else {
        setDraft({ slot: "subject_format", geo: "", schoolTier: "", value: "" });
        await load();
      }
    } finally {
      setAdding(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this override?")) return;
    const r = await fetch(`/api/email-templates/overrides?id=${id}`, { method: "DELETE" });
    if (r.ok) await load();
  };

  return (
    <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--border-light)" }}>
      <div style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600, marginBottom: 8 }}>
        Segment overrides
      </div>
      {err && <div style={{ fontSize: 12, color: "#dc2626", marginBottom: 8 }}>{err}</div>}
      {loading ? (
        <div className="skeleton" style={{ height: 40 }} />
      ) : overrides.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 10 }}>
          None — slots fall back to the template defaults above. Add an override to swap a slot for a specific lead segment.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
          {overrides.map((o) => (
            <div key={o.id} style={{ padding: "8px 10px", border: "1px solid var(--border-light)", borderRadius: 6, fontSize: 12, background: "var(--bg)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <div>
                  <strong>{SLOT_OPTIONS.find((s) => s.value === o.slot_name)?.label ?? o.slot_name}</strong>
                  <span style={{ marginLeft: 8, color: "var(--muted)" }}>
                    when {Object.keys(o.when).length === 0 ? "(always)" : Object.entries(o.when).map(([k, v]) => `${k}=${v}`).join(", ")}
                  </span>
                </div>
                <button onClick={() => remove(o.id)} className="btn" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "#dc2626" }}>
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
              <div style={{ fontSize: 11, fontFamily: "var(--font-mono, ui-monospace, monospace)", color: "var(--text-secondary)", whiteSpace: "pre-wrap" }}>
                {o.value.length > 200 ? `${o.value.slice(0, 200)}…` : o.value}
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: 10, border: "1px dashed var(--border)", borderRadius: 6 }}>
        <div style={{ display: "flex", gap: 8 }}>
          <select value={draft.slot} onChange={(e) => setDraft({ ...draft, slot: e.target.value })} style={{ padding: "4px 8px", fontSize: 12, border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg)" }}>
            {SLOT_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
          <select value={draft.geo} onChange={(e) => setDraft({ ...draft, geo: e.target.value })} style={{ padding: "4px 8px", fontSize: 12, border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg)" }}>
            <option value="">geo: any</option>
            <option value="cn">geo: cn</option>
            <option value="edu">geo: edu</option>
            <option value="other">geo: other</option>
          </select>
          <select value={draft.schoolTier} onChange={(e) => setDraft({ ...draft, schoolTier: e.target.value })} style={{ padding: "4px 8px", fontSize: 12, border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg)" }}>
            <option value="">tier: any</option>
            <option value="1">tier: 1</option>
            <option value="2">tier: 2</option>
            <option value="3">tier: 3</option>
          </select>
        </div>
        <textarea
          placeholder="Override value for this slot when the segment matches…"
          value={draft.value}
          onChange={(e) => setDraft({ ...draft, value: e.target.value })}
          rows={2}
          style={{ padding: "6px 8px", fontSize: 12, fontFamily: "var(--font-mono, ui-monospace, monospace)", border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg)", resize: "vertical" }}
        />
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button onClick={add} disabled={adding || !draft.value.trim()} className="btn" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12 }}>
            {adding ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
            Add override
          </button>
        </div>
      </div>
    </div>
  );
}

