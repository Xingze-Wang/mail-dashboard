"use client";

/**
 * /templates/[id]/inspect
 *
 * The "see how the sausage is made" view. Shows the rendered email
 * with each paragraph badged by provenance:
 *   • fixed (gray) — literal template text
 *   • segment_selected (amber) — segment-conditional swap fired
 *   • rule_computed (blue) — value derived from program rules
 *   • ai_generated (purple) — LLM produced this; click to see prompt
 *
 * Clicking any paragraph opens the side panel with source_format,
 * selection_reason, or resolved_prompt as appropriate.
 *
 * The user's framing: "as you click into each ai generated part /
 * selected part it shows the selection/generation prompt". This is
 * exactly that.
 *
 * Security: all rendered HTML goes through sanitizeHtml (DOMPurify-
 * based) before dangerouslySetInnerHTML. The HTML comes from our own
 * assembleDraft (which itself escapes lead-supplied content), but the
 * sanitize step is defense-in-depth — paper title/abstract is the
 * one place adversarial input could in theory survive into a render.
 */

import { useEffect, useState, use } from "react";
import { Loader2, X, AlertCircle, Sparkles, Settings, Cog, Type } from "lucide-react";
import { sanitizeHtml } from "@/lib/sanitize";

interface Part {
  slot: string;
  kind: "fixed" | "segment_selected" | "rule_computed" | "ai_generated";
  rendered: string;
  source_format?: string;
  resolved_prompt?: string;
  selection_reason?: string;
}

interface InspectResponse {
  template: { id: string; name: string; status: string; segment_default: string | null };
  lead: {
    id: string;
    title: string;
    author_email: string;
    first_name: string | null;
    school_name: string | null;
    school_tier: number | null;
    matched_directions: string[] | null;
  };
  rendered: { subject: string; html: string };
  parts: Part[];
  intro_prompt_resolved: string;
  intro_output: string;
}

const KIND_STYLE: Record<Part["kind"], { bg: string; border: string; text: string; label: string; Icon: typeof Sparkles }> = {
  fixed: { bg: "bg-slate-50", border: "border-slate-300", text: "text-slate-700", label: "FIXED", Icon: Type },
  segment_selected: { bg: "bg-amber-50", border: "border-amber-300", text: "text-amber-700", label: "SEGMENT-SELECTED", Icon: Settings },
  rule_computed: { bg: "bg-blue-50", border: "border-blue-300", text: "text-blue-700", label: "RULE-COMPUTED", Icon: Cog },
  ai_generated: { bg: "bg-purple-50", border: "border-purple-400", text: "text-purple-700", label: "AI-GENERATED", Icon: Sparkles },
};

const SLOT_LABEL: Record<string, string> = {
  subject: "Subject line",
  greeting: "Greeting",
  intro: "Personalized intro (LLM)",
  rep_intro: "Rep intro paragraph",
  school_pitch: "School + compute pitch",
  cta_signoff: "CTA + signoff",
  signature: "Signature",
};

export default function TemplateInspectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<InspectResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState(false);
  const [openPart, setOpenPart] = useState<Part | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/templates/${id}/inspect`, { credentials: "include" });
        if (cancelled) return;
        if (res.status === 403) { setAuthError(true); return; }
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          alert(`Inspect failed: ${err.error ?? res.status}`);
          return;
        }
        setData((await res.json()) as InspectResponse);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  if (authError) {
    return (
      <div className="max-w-2xl mx-auto p-8">
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
          <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-3" />
          <h1 className="text-xl font-semibold text-red-900 mb-2">Admin only</h1>
        </div>
      </div>
    );
  }

  if (loading || !data) {
    return (
      <div className="p-12 text-center">
        <Loader2 className="w-6 h-6 animate-spin text-slate-400 mx-auto" />
        <p className="text-sm text-slate-500 mt-2">Rendering against a real lead…</p>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto p-6">
      <div className="mb-5">
        <h1 className="text-2xl font-semibold text-slate-900">
          Inspecting <span className="font-mono text-base">{data.template.name}</span>
        </h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Status: {data.template.status}
          {data.template.segment_default && ` · segment_default=${data.template.segment_default}`}
          {" · "}sample lead: {data.lead.school_name ?? "(no school)"} ({data.lead.author_email})
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-2">
          <h2 className="text-sm font-medium text-slate-700 mb-2">Parts (click any block for details)</h2>
          {data.parts.map((part) => {
            const style = KIND_STYLE[part.kind];
            return (
              <button
                key={part.slot}
                onClick={() => setOpenPart(part)}
                className={`w-full text-left ${style.bg} border ${style.border} rounded-md p-3 hover:shadow-sm transition`}
              >
                <div className="flex items-center gap-2 mb-1.5">
                  <style.Icon className={`w-3.5 h-3.5 ${style.text}`} />
                  <span className={`text-[10px] font-medium ${style.text}`}>{style.label}</span>
                  <span className="text-[10px] text-slate-400 font-mono">{SLOT_LABEL[part.slot] ?? part.slot}</span>
                </div>
                {part.slot === "subject" ? (
                  <div className="text-sm font-medium text-slate-900">{part.rendered}</div>
                ) : (
                  <div
                    className="text-[12px] text-slate-700 leading-relaxed prose prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: sanitizeHtml(part.rendered) }}
                  />
                )}
                {(part.selection_reason || part.kind === "ai_generated") && (
                  <div className="mt-1.5 text-[10px] text-slate-500 font-mono">
                    {part.kind === "ai_generated" ? "click to see Gemini prompt" : part.selection_reason}
                  </div>
                )}
              </button>
            );
          })}
        </div>

        <div>
          <h2 className="text-sm font-medium text-slate-700 mb-2">Full rendered preview</h2>
          <div className="bg-white border border-slate-200 rounded-md p-4">
            <div className="text-xs font-semibold text-slate-700 mb-3 pb-2 border-b border-slate-100">
              {data.rendered.subject}
            </div>
            <div
              className="text-[13px] text-slate-700 leading-relaxed prose prose-sm max-w-none"
              dangerouslySetInnerHTML={{ __html: sanitizeHtml(data.rendered.html) }}
            />
          </div>
        </div>
      </div>

      {openPart && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-end" onClick={() => setOpenPart(null)}>
          <div className="bg-white h-full w-full max-w-2xl shadow-xl overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-slate-200 sticky top-0 bg-white">
              <div className="flex items-center gap-2">
                <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${KIND_STYLE[openPart.kind].bg} ${KIND_STYLE[openPart.kind].text} border ${KIND_STYLE[openPart.kind].border}`}>
                  {KIND_STYLE[openPart.kind].label}
                </span>
                <h2 className="text-base font-semibold text-slate-900">{SLOT_LABEL[openPart.slot] ?? openPart.slot}</h2>
              </div>
              <button onClick={() => setOpenPart(null)} className="p-1 text-slate-400 hover:text-slate-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 space-y-4">
              <div>
                <div className="text-xs font-medium text-slate-500 mb-1">Rendered</div>
                <div
                  className="text-[12px] text-slate-700 leading-relaxed prose prose-sm max-w-none p-3 bg-slate-50 rounded border border-slate-200"
                  dangerouslySetInnerHTML={{ __html: sanitizeHtml(openPart.rendered) }}
                />
              </div>
              {openPart.source_format && openPart.kind !== "ai_generated" && (
                <div>
                  <div className="text-xs font-medium text-slate-500 mb-1">Source format (template)</div>
                  <pre className="text-[11px] font-mono text-slate-700 leading-relaxed p-3 bg-slate-50 rounded border border-slate-200 whitespace-pre-wrap">{openPart.source_format}</pre>
                </div>
              )}
              {openPart.selection_reason && openPart.kind !== "ai_generated" && (
                <div>
                  <div className="text-xs font-medium text-slate-500 mb-1">Selection reason</div>
                  <pre className="text-[11px] font-mono text-slate-700 p-2 bg-slate-50 rounded border border-slate-200">{openPart.selection_reason}</pre>
                </div>
              )}
              {openPart.kind === "ai_generated" && openPart.resolved_prompt && (
                <div>
                  <div className="text-xs font-medium text-slate-500 mb-1">Resolved prompt fed to Gemini</div>
                  <pre className="text-[11px] font-mono text-slate-700 leading-relaxed p-3 bg-purple-50 rounded border border-purple-200 whitespace-pre-wrap">{openPart.resolved_prompt}</pre>
                </div>
              )}
              {openPart.kind === "ai_generated" && data.intro_output && (
                <div>
                  <div className="text-xs font-medium text-slate-500 mb-1">Raw LLM output (pre-HTML-escape)</div>
                  <pre className="text-[11px] font-mono text-slate-700 leading-relaxed p-3 bg-purple-50 rounded border border-purple-200 whitespace-pre-wrap">{data.intro_output}</pre>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
