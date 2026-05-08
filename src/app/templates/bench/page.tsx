"use client";

/**
 * /templates/bench
 *
 * Visual side-by-side template comparison. Pulls N recent real leads
 * (filtered by segment) from pipeline_leads, renders each lead under
 * EVERY non-archived email_templates row (including 'proposal' rows
 * from congress), shows the result as a grid: rows=leads, cols=templates.
 *
 * Each cell shows the actual rendered subject + body (real Gemini call
 * for the personalized intro). This is what the user meant by "看一下
 * 不同的模版面对几个sample paper搞成什么样" — bench-style visualization.
 *
 * Per the "我们一定要有数据" rule (memory feedback_data_required), the
 * cells show real output from real prompts on real leads, not stubs.
 *
 * Cost shape: leads × templates Gemini calls per render. Bounded at
 * 5 × ~6 = 30. Admin clicks "Run" deliberately, not auto-fired.
 *
 * Security: HTML cells go through sanitizeHtml (DOMPurify) before
 * dangerouslySetInnerHTML. Even though the HTML comes from our own
 * assembleDraft, the personalized-intro paragraph is Gemini output
 * substituted into the template — an adversarial paper title or
 * abstract could in theory inject script. DOMPurify strips that.
 */

import { useCallback, useState } from "react";
import {
  Loader2, Play, AlertCircle, Mail, BadgeCheck, Tag, Brain, CheckCircle2,
  GitFork, X,
} from "lucide-react";
import { sanitizeHtml } from "@/lib/sanitize";

const FORKABLE_SLOTS = [
  { key: "subject_format", label: "Subject line" },
  { key: "intro_prompt", label: "Intro (LLM prompt)" },
  { key: "greeting_format", label: "Greeting" },
  { key: "rep_intro_format", label: "Rep intro paragraph" },
  { key: "school_pitch_format", label: "School + compute pitch" },
  { key: "cta_signoff_format", label: "CTA + signoff" },
] as const;
type SlotKey = typeof FORKABLE_SLOTS[number]["key"];

interface SlotsResponse {
  id: string;
  name: string;
  status: string;
  segment_default: string | null;
  subject_format: string;
  intro_prompt: string;
  greeting_format: string;
  rep_intro_format: string;
  school_pitch_format: string;
  cta_signoff_format: string;
}

interface Lead {
  id: number;
  title: string;
  author_email: string;
  first_name: string | null;
  school_name: string | null;
  school_tier: number | null;
  matched_directions: string[] | null;
}

interface Template {
  id: string;
  name: string;
  rep_id: number | null;
  status: "active" | "proposal" | "archived";
  segment_default: string | null;
  // Historical performance over last 90 days. Empty (sent=0) for new
  // templates / proposals — UI hides the metric block when sent<10
  // because rates on tiny n are misleading.
  perf90d: { sent: number; clicked: number; wechat: number };
}

interface Cell {
  lead_id: number;
  template_id: string;
  subject: string;
  html: string;
  error: string | null;
}

interface BenchResult {
  leads: Lead[];
  templates: Template[];
  cells: Cell[];
}

type Segment = "all" | "cn" | "overseas" | "edu";

const SEGMENT_LABEL: Record<Segment, string> = {
  all: "All",
  cn: "CN (.cn)",
  overseas: "Overseas",
  edu: "EDU",
};

export default function TemplatesBenchPage() {
  const [segment, setSegment] = useState<Segment>("cn");
  const [n, setN] = useState(3);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<BenchResult | null>(null);
  const [authError, setAuthError] = useState(false);
  // Psychologist critiques: keyed by `${lead_id}|${template_id}`. Each
  // entry stores either the critique markdown string or 'loading'/'error'.
  // Calls are on-demand per cell — admin clicks the brain icon when
  // they want to know WHY a cell reads the way it does.
  const [critiques, setCritiques] = useState<Record<string, { state: "loading" | "ready" | "error"; text: string }>>({});

  // Fork modal state. When non-null, the modal is open editing a fork
  // of `parent`. The user picks ONE slot to vary (typically — multi-slot
  // forks are allowed but discouraged because they confound future A/B
  // signal). On Save, POST /api/templates/fork creates a status='proposal'
  // row that shows up as a new column on the next bench Run.
  const [forkParent, setForkParent] = useState<SlotsResponse | null>(null);
  const [forkLoading, setForkLoading] = useState(false);
  const [forkName, setForkName] = useState("");
  const [forkSlot, setForkSlot] = useState<SlotKey>("school_pitch_format");
  const [forkValue, setForkValue] = useState("");
  const [forkSegment, setForkSegment] = useState<string>("");

  const run = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/templates/bench?segment=${segment}&n=${n}`, {
        credentials: "include",
      });
      if (res.status === 403) {
        setAuthError(true);
        return;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`Bench failed: ${err.error ?? res.status}`);
        return;
      }
      const data = (await res.json()) as BenchResult;
      setResult(data);
    } finally {
      setLoading(false);
    }
  }, [segment, n]);

  const openForkModal = useCallback(async (templateId: string) => {
    setForkLoading(true);
    try {
      const res = await fetch(`/api/templates/${templateId}/slots`, { credentials: "include" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`Couldn't load template: ${err.error ?? res.status}`);
        return;
      }
      const data = (await res.json()) as SlotsResponse;
      setForkParent(data);
      // Suggest a name like "fork_<parent>_<dateY-M-D>"
      setForkName(`fork_${data.name}_${new Date().toISOString().slice(2, 10).replace(/-/g, "")}`);
      // Default to varying school_pitch (the highest-leverage paragraph
      // per design doc § 1) but pre-fill with the parent's value.
      setForkSlot("school_pitch_format");
      setForkValue(data.school_pitch_format);
      setForkSegment(data.segment_default ?? "");
    } finally {
      setForkLoading(false);
    }
  }, []);

  const closeForkModal = useCallback(() => {
    setForkParent(null);
    setForkName("");
    setForkValue("");
    setForkSegment("");
  }, []);

  const submitFork = useCallback(async () => {
    if (!forkParent) return;
    if (!forkName.trim()) {
      alert("Name is required");
      return;
    }
    // Refuse no-op forks: if the chosen slot's value matches the parent,
    // there's nothing to test. (Multi-slot forks could still be useful
    // here, but v1 only edits one — tighten later if needed.)
    const parentValue = (forkParent as unknown as Record<string, string>)[forkSlot];
    if (parentValue === forkValue) {
      alert(`The ${forkSlot} content is identical to the parent — nothing to fork.`);
      return;
    }
    try {
      const res = await fetch("/api/templates/fork", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parent_id: forkParent.id,
          name: forkName.trim(),
          overrides: { [forkSlot]: forkValue },
          segment_default: forkSegment.trim() || null,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`Fork failed: ${err.error ?? res.status}`);
        return;
      }
      closeForkModal();
      // Re-run so the new proposal column appears in the grid.
      void run();
    } catch (e) {
      alert(`Fork failed: ${(e as Error).message}`);
    }
  }, [forkParent, forkName, forkSlot, forkValue, forkSegment, closeForkModal, run]);

  const promoteProposal = useCallback(
    async (templateId: string, name: string) => {
      // Confirm — this changes prod behavior (loadEffectiveTemplate
      // will start picking this row up). Safer to require an explicit
      // click than to do it silently on the bench.
      const ok = window.confirm(
        `Activate "${name}"? It will become a candidate for production sends. Existing 'global' / per-rep templates are NOT auto-archived — you'll need to demote those separately if needed.`,
      );
      if (!ok) return;
      try {
        const res = await fetch(`/api/templates/${templateId}/promote`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          alert(`Promote failed: ${err.error ?? res.status}`);
          return;
        }
        // Optimistic: flip the local copy. A full re-run would re-render
        // every Gemini call, which is wasteful and slow.
        setResult((prev) =>
          prev
            ? {
                ...prev,
                templates: prev.templates.map((t) =>
                  t.id === templateId ? { ...t, status: "active" } : t,
                ),
              }
            : prev,
        );
      } catch (e) {
        alert(`Promote failed: ${(e as Error).message}`);
      }
    },
    [],
  );

  const requestCritique = useCallback(async (leadId: number, templateId: string) => {
    const key = `${leadId}|${templateId}`;
    setCritiques((prev) => ({ ...prev, [key]: { state: "loading", text: "" } }));
    try {
      const res = await fetch("/api/templates/critique", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lead_id: leadId, template_id: templateId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setCritiques((prev) => ({ ...prev, [key]: { state: "error", text: err.error ?? `HTTP ${res.status}` } }));
        return;
      }
      const data = (await res.json()) as { critique: string };
      setCritiques((prev) => ({ ...prev, [key]: { state: "ready", text: data.critique } }));
    } catch (e) {
      setCritiques((prev) => ({ ...prev, [key]: { state: "error", text: (e as Error).message } }));
    }
  }, []);

  if (authError) {
    return (
      <div className="max-w-2xl mx-auto p-8">
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
          <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-3" />
          <h1 className="text-xl font-semibold text-red-900 mb-2">Admin only</h1>
          <p className="text-red-700 text-sm">Restricted to reps with role = admin.</p>
        </div>
      </div>
    );
  }

  // Build a quick (lead_id, template_id) → cell lookup so the grid
  // render below is O(1) per cell.
  const cellMap = new Map<string, Cell>();
  for (const c of result?.cells ?? []) {
    cellMap.set(`${c.lead_id}|${c.template_id}`, c);
  }

  return (
    <div className="max-w-[1600px] mx-auto p-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Template bench</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Real leads × all templates. Each cell is what would actually be sent.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className="text-sm text-slate-600">Segment:</span>
            <select
              value={segment}
              onChange={(e) => setSegment(e.target.value as Segment)}
              className="text-sm border border-slate-300 rounded px-2 py-1.5"
              disabled={loading}
            >
              {(Object.keys(SEGMENT_LABEL) as Segment[]).map((s) => (
                <option key={s} value={s}>{SEGMENT_LABEL[s]}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-sm text-slate-600">N leads:</span>
            <input
              type="number"
              min={1}
              max={10}
              value={n}
              onChange={(e) => setN(Math.max(1, Math.min(10, Number(e.target.value))))}
              className="text-sm border border-slate-300 rounded px-2 py-1.5 w-16"
              disabled={loading}
            />
          </div>
          <button
            onClick={() => void run()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-slate-900 text-white rounded text-sm hover:bg-slate-800 disabled:opacity-50"
          >
            {loading ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Rendering…</>
            ) : (
              <><Play className="w-4 h-4" /> Run</>
            )}
          </button>
        </div>
      </div>

      {!result && !loading && (
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-10 text-center">
          <Mail className="w-10 h-10 text-slate-400 mx-auto mb-3" />
          <p className="text-slate-600 font-medium">Pick a segment + N, then click Run.</p>
          <p className="text-slate-500 text-sm mt-1">
            Each cell makes a real Gemini call to render the personalized intro,
            so a 3 × 2 grid takes ~30s.
          </p>
        </div>
      )}

      {result && result.leads.length === 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-6 text-center">
          <p className="text-amber-900 font-medium">
            No leads matched segment={segment} in the recent pull.
          </p>
        </div>
      )}

      {forkParent && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-3xl w-full max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b border-slate-200">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">
                  Fork "{forkParent.name}"
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Pick one paragraph slot to vary. Saves as a new template with status=proposal — preview it on the bench, then promote when you like it.
                </p>
              </div>
              <button
                onClick={closeForkModal}
                className="text-slate-400 hover:text-slate-600 p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  New template name
                </label>
                <input
                  type="text"
                  value={forkName}
                  onChange={(e) => setForkName(e.target.value)}
                  className="w-full text-sm border border-slate-300 rounded px-2 py-1.5 font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Default segment (optional)
                </label>
                <select
                  value={forkSegment}
                  onChange={(e) => setForkSegment(e.target.value)}
                  className="w-full text-sm border border-slate-300 rounded px-2 py-1.5"
                >
                  <option value="">(none)</option>
                  <option value="cn">cn</option>
                  <option value="overseas">overseas</option>
                  <option value="edu">edu</option>
                  <option value="fallback">fallback</option>
                </select>
                <p className="text-[11px] text-slate-500 mt-1">
                  When set + status=active, future loads will route this segment to this template by default.
                </p>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Vary which paragraph?
                </label>
                <select
                  value={forkSlot}
                  onChange={(e) => {
                    const newSlot = e.target.value as SlotKey;
                    setForkSlot(newSlot);
                    setForkValue((forkParent as unknown as Record<string, string>)[newSlot]);
                  }}
                  className="w-full text-sm border border-slate-300 rounded px-2 py-1.5"
                >
                  {FORKABLE_SLOTS.map((s) => (
                    <option key={s.key} value={s.key}>{s.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  New content (parent value pre-filled — edit it)
                </label>
                <textarea
                  value={forkValue}
                  onChange={(e) => setForkValue(e.target.value)}
                  rows={12}
                  className="w-full text-xs border border-slate-300 rounded px-2 py-1.5 font-mono leading-relaxed"
                />
                <p className="text-[11px] text-slate-500 mt-1">
                  All other paragraphs will be inherited unchanged from "{forkParent.name}".
                </p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 p-4 border-t border-slate-200 bg-slate-50">
              <button
                onClick={closeForkModal}
                className="px-3 py-1.5 text-sm border border-slate-300 rounded hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                onClick={() => void submitFork()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-900 text-white rounded text-sm hover:bg-slate-800"
              >
                <GitFork className="w-3.5 h-3.5" /> Save as proposal
              </button>
            </div>
          </div>
        </div>
      )}

      {result && result.leads.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-2">
            <thead>
              <tr>
                <th className="text-left text-sm font-medium text-slate-700 align-bottom min-w-[280px]">
                  Lead ↓ / Template →
                </th>
                {result.templates.map((tpl) => {
                  const p = tpl.perf90d;
                  const enoughData = p.sent >= 10;
                  const clickRate = p.sent > 0 ? (p.clicked / p.sent) * 100 : 0;
                  const wechatRate = p.sent > 0 ? (p.wechat / p.sent) * 100 : 0;
                  return (
                    <th
                      key={tpl.id}
                      className="text-left text-sm font-medium text-slate-700 min-w-[420px] align-bottom px-2 pb-2"
                    >
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-mono text-xs">{tpl.name}</span>
                        {tpl.status === "proposal" && (
                          <>
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-200">
                              PROPOSAL
                            </span>
                            <button
                              onClick={() => void promoteProposal(tpl.id, tpl.name)}
                              className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100"
                              title="Promote this proposal to status='active' — it'll become a candidate for production sends"
                            >
                              <CheckCircle2 className="w-2.5 h-2.5" /> Activate
                            </button>
                          </>
                        )}
                        {tpl.segment_default && (
                          <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">
                            <Tag className="w-2.5 h-2.5" /> {tpl.segment_default}
                          </span>
                        )}
                        {tpl.rep_id != null && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
                            rep {tpl.rep_id}
                          </span>
                        )}
                        <button
                          onClick={() => void openForkModal(tpl.id)}
                          className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-slate-50 text-slate-600 border border-slate-200 hover:bg-slate-100 ml-auto"
                          title="Fork this template — vary one paragraph and save as a new proposal"
                          disabled={forkLoading}
                        >
                          <GitFork className="w-2.5 h-2.5" /> Fork
                        </button>
                      </div>
                      {/*
                        Historical metrics row. Only shows when there's
                        statistical weight (≥10 sends in 90 days). Tiny
                        n produces noisy rates — better to hide than to
                        mislead the admin into thinking 1/1 = 100%.
                      */}
                      <div className="text-[11px] text-slate-500 mt-1 font-normal">
                        {enoughData ? (
                          <span className="inline-flex items-center gap-2">
                            <span className="font-mono">n={p.sent}</span>
                            <span title="Click rate (90d)">
                              click <span className="text-slate-700 font-medium">{clickRate.toFixed(1)}%</span>
                            </span>
                            <span title="WeChat conversion rate (90d)">
                              wechat <span className="text-slate-700 font-medium">{wechatRate.toFixed(1)}%</span>
                            </span>
                          </span>
                        ) : p.sent > 0 ? (
                          <span className="text-slate-400">n={p.sent} (need ≥10 for rates)</span>
                        ) : (
                          <span className="text-slate-400">no sends yet</span>
                        )}
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {result.leads.map((lead) => (
                <tr key={lead.id}>
                  <td className="text-sm text-slate-700 align-top bg-slate-50 border border-slate-200 rounded p-3">
                    <div className="font-medium leading-snug mb-1.5 line-clamp-3">
                      {lead.title}
                    </div>
                    <div className="text-xs text-slate-500 font-mono break-all">
                      {lead.author_email}
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      {lead.school_name ?? "(no school)"}
                      {lead.school_tier != null && ` • tier ${lead.school_tier}`}
                    </div>
                    {lead.matched_directions && lead.matched_directions.length > 0 && (
                      <div className="text-[11px] text-slate-500 mt-1.5 flex flex-wrap gap-1">
                        {lead.matched_directions.slice(0, 3).map((d) => (
                          <span
                            key={d}
                            className="px-1.5 py-0.5 bg-white border border-slate-200 rounded"
                          >
                            {d}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  {result.templates.map((tpl) => {
                    const cell = cellMap.get(`${lead.id}|${tpl.id}`);
                    if (!cell) return <td key={tpl.id} className="border border-slate-200 rounded p-2 text-xs text-slate-400">—</td>;
                    if (cell.error) {
                      return (
                        <td key={tpl.id} className="border border-red-200 rounded p-3 bg-red-50">
                          <div className="text-xs font-medium text-red-700 mb-1">Render error</div>
                          <div className="text-[11px] text-red-600 font-mono">{cell.error}</div>
                        </td>
                      );
                    }
                    return (
                      <td
                        key={tpl.id}
                        className="border border-slate-200 rounded p-3 align-top bg-white"
                      >
                        <div className="text-xs font-semibold text-slate-700 mb-2 leading-snug">
                          {cell.subject}
                        </div>
                        <div
                          className="text-[12px] text-slate-700 leading-relaxed prose prose-sm max-w-none"
                          dangerouslySetInnerHTML={{ __html: sanitizeHtml(cell.html) }}
                        />
                        <div className="mt-2 pt-2 border-t border-slate-100 flex items-center gap-3 flex-wrap">
                          <a
                            className="text-[11px] text-slate-500 hover:text-slate-700 inline-flex items-center gap-1"
                            href={`#`}
                            onClick={(e) => {
                              e.preventDefault();
                              // Open in new tab via blob URL — safer than
                              // document.write (which is flagged by the
                              // security hook) and gives a real browser
                              // navigation experience.
                              const safe = sanitizeHtml(cell.html);
                              const fullDoc = `<!doctype html><html><head><meta charset="utf-8"><title>${cell.subject.replace(/[<>]/g, "")}</title></head><body>${safe}</body></html>`;
                              const blob = new Blob([fullDoc], { type: "text/html" });
                              const u = URL.createObjectURL(blob);
                              window.open(u, "_blank");
                              // Revoke after a delay so the new tab has time to load
                              setTimeout(() => URL.revokeObjectURL(u), 30_000);
                            }}
                          >
                            <BadgeCheck className="w-3 h-3" /> Open full preview
                          </a>
                          <button
                            className="text-[11px] text-purple-600 hover:text-purple-800 inline-flex items-center gap-1 disabled:opacity-50"
                            onClick={() => void requestCritique(lead.id, tpl.id)}
                            disabled={critiques[`${lead.id}|${tpl.id}`]?.state === "loading"}
                            title="Ask a psychologist-style critique of each paragraph for this recipient"
                          >
                            {critiques[`${lead.id}|${tpl.id}`]?.state === "loading" ? (
                              <><Loader2 className="w-3 h-3 animate-spin" /> Reading…</>
                            ) : (
                              <><Brain className="w-3 h-3" /> Psychologist read</>
                            )}
                          </button>
                        </div>
                        {(() => {
                          const c = critiques[`${lead.id}|${tpl.id}`];
                          if (!c || c.state === "loading") return null;
                          if (c.state === "error") {
                            return (
                              <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded text-[11px] text-red-700">
                                Critique failed: {c.text}
                              </div>
                            );
                          }
                          return (
                            <div className="mt-2 p-2.5 bg-purple-50 border border-purple-200 rounded text-[11px] text-purple-900 whitespace-pre-wrap leading-relaxed max-h-96 overflow-y-auto">
                              {c.text}
                            </div>
                          );
                        })()}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
