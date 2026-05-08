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
import { Loader2, Play, AlertCircle, Mail, BadgeCheck, Tag, Brain } from "lucide-react";
import { sanitizeHtml } from "@/lib/sanitize";

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

      {result && result.leads.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-2">
            <thead>
              <tr>
                <th className="text-left text-sm font-medium text-slate-700 align-bottom min-w-[280px]">
                  Lead ↓ / Template →
                </th>
                {result.templates.map((tpl) => (
                  <th
                    key={tpl.id}
                    className="text-left text-sm font-medium text-slate-700 min-w-[420px] align-bottom px-2 pb-2"
                  >
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-mono text-xs">{tpl.name}</span>
                      {tpl.status === "proposal" && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-200">
                          PROPOSAL
                        </span>
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
                    </div>
                  </th>
                ))}
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
