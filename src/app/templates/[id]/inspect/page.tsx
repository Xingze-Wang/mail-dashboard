"use client";

/**
 * /templates/[id]/inspect
 *
 * Renders one template against N real leads (default 5) so the admin
 * sees variation across recipients. Per user feedback: 'when inspect
 * should load against like many real leads and more if this make sense'.
 *
 * Each lead becomes a row in a left sidebar; selecting one swaps the
 * detail view (parts list + full rendered preview) without re-fetching.
 * Failures render a red banner per-lead instead of crashing the page.
 *
 * Click any part block in the detail view to open a side panel showing
 * source_format, selection_reason, or resolved_prompt as appropriate
 * (subject_format / segment_selected / rule_computed / ai_generated).
 *
 * Security: all rendered HTML goes through sanitizeHtml (DOMPurify-
 * based) before dangerouslySetInnerHTML.
 */

import { useEffect, useState, use } from "react";
import { Loader2, X, AlertCircle, Sparkles, Settings, Cog, Type, FileText } from "lucide-react";
import { sanitizeHtml } from "@/lib/sanitize";

interface Part {
  slot: string;
  kind: "fixed" | "segment_selected" | "rule_computed" | "ai_generated";
  rendered: string;
  source_format?: string;
  resolved_prompt?: string;
  selection_reason?: string;
}

interface RenderingLead {
  id: string;
  title: string;
  author_email: string;
  first_name: string | null;
  school_name: string | null;
  school_tier: number | null;
  matched_directions: string[];
  assigned_rep: { name: string; wechat: string };
  /** True if this lead has never received an email — i.e. would be a
   *  real prospect for this template tomorrow morning. False = backfill. */
  is_unsent: boolean;
}

interface Rendering {
  lead: RenderingLead;
  rendered: { subject: string; html: string } | null;
  parts: Part[] | null;
  intro_prompt_resolved: string | null;
  intro_output: string | null;
  error: string | null;
}

interface InspectResponse {
  template: { id: string; name: string; status: string; segment_default: string | null };
  audience?: { segment_used: string; n_unsent: number; n_sent_backfill: number };
  renderings: Rendering[];
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

// 'auto' = use the template's own segment_default (server-side resolves it).
// This is the default because most reps want to see "the audience this
// template would actually email", not random leads from all segments.
const SEGMENT_LABEL = { auto: "Auto (template segment)", all: "All", cn: "CN (.cn)", overseas: "Overseas", edu: "EDU" } as const;
type Segment = keyof typeof SEGMENT_LABEL;

export default function TemplateInspectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<InspectResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState(false);
  const [openPart, setOpenPart] = useState<Part | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [segment, setSegment] = useState<Segment>("auto");
  const [n, setN] = useState(5);

  const load = async (params: { segment?: Segment; n?: number } = {}) => {
    const s = params.segment ?? segment;
    const count = params.n ?? n;
    setLoading(true);
    try {
      const res = await fetch(`/api/templates/${id}/inspect?segment=${s}&n=${count}`, {
        credentials: "include",
      });
      if (res.status === 403) { setAuthError(true); return; }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`Inspect failed: ${err.error ?? res.status}`);
        return;
      }
      setData((await res.json()) as InspectResponse);
      setActiveIdx(0);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        <p className="text-sm text-slate-500 mt-2">Rendering against {n} real leads…</p>
      </div>
    );
  }

  const active = data.renderings[activeIdx];

  return (
    <div className="max-w-[1600px] mx-auto p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-5 gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-slate-900 truncate">
            Inspecting <span className="font-mono text-base">{data.template.name}</span>
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Status: {data.template.status}
            {data.template.segment_default && ` · segment_default=${data.template.segment_default}`}
            {" · "}rendered against {data.renderings.length} lead{data.renderings.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <select
            value={segment}
            onChange={(e) => { const s = e.target.value as Segment; setSegment(s); void load({ segment: s }); }}
            className="text-sm border border-slate-300 rounded px-2 py-1.5"
          >
            {(Object.keys(SEGMENT_LABEL) as Segment[]).map((s) => (
              <option key={s} value={s}>{SEGMENT_LABEL[s]}</option>
            ))}
          </select>
          <input
            type="number"
            min={1}
            max={10}
            value={n}
            onChange={(e) => setN(Math.max(1, Math.min(10, Number(e.target.value))))}
            onBlur={() => void load()}
            className="w-16 text-sm border border-slate-300 rounded px-2 py-1.5"
          />
          <button
            onClick={() => void load()}
            className="text-xs px-3 py-1.5 border border-slate-300 rounded hover:bg-slate-50"
          >
            Reload
          </button>
        </div>
      </div>

      {/* Approval actions bar — visible for proposal/approved_draft.
          Two-stage approval: approve-draft (sign off prose) →
          activate (sign off routing). Per migration 066. */}
      {(data.template.status === "proposal" || data.template.status === "approved_draft") && (
        <ApprovalBar template={data.template} onChanged={() => void load()} />
      )}

      {/* Audience strip — explains who these leads are */}
      {data.audience && (
        <div className="mb-4 p-3 bg-emerald-50 border border-emerald-200 rounded text-xs text-emerald-900 flex items-center gap-3">
          <span className="font-medium">Audience:</span>
          <span>
            <span className="font-mono font-medium">{data.audience.segment_used}</span> segment
          </span>
          <span className="text-emerald-700">·</span>
          <span>
            <span className="font-bold">{data.audience.n_unsent}</span> never-sent (real preview)
          </span>
          {data.audience.n_sent_backfill > 0 && (
            <>
              <span className="text-emerald-700">·</span>
              <span className="text-emerald-800/80">
                <span className="font-bold">{data.audience.n_sent_backfill}</span> backfill (already-sent leads, for variety)
              </span>
            </>
          )}
        </div>
      )}

      <div className="grid grid-cols-[280px_1fr] gap-4">
        {/* Lead sidebar */}
        <aside className="space-y-2">
          <h2 className="text-xs font-medium text-slate-500 uppercase tracking-wide">Leads</h2>
          {data.renderings.map((r, i) => {
            const isActive = i === activeIdx;
            const isErr = r.error != null;
            return (
              <button
                key={r.lead.id}
                onClick={() => setActiveIdx(i)}
                className={`w-full text-left rounded-md p-2.5 transition border ${
                  isActive
                    ? "bg-slate-900 border-slate-900 text-white"
                    : isErr
                      ? "bg-red-50 border-red-200 hover:bg-red-100 text-red-900"
                      : "bg-white border-slate-200 hover:bg-slate-50"
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <div className="text-[11px] font-mono opacity-70 truncate flex-1">
                    {r.lead.author_email}
                  </div>
                  {r.lead.is_unsent ? (
                    <span
                      title="Never emailed yet — would be a real prospect for this template"
                      className={`text-[9px] font-bold uppercase px-1 py-0.5 rounded ${
                        isActive ? "bg-emerald-400 text-emerald-900" : "bg-emerald-100 text-emerald-700"
                      }`}
                    >
                      FRESH
                    </span>
                  ) : (
                    <span
                      title="Already emailed before — shown as backfill so you have variety"
                      className={`text-[9px] font-bold uppercase px-1 py-0.5 rounded ${
                        isActive ? "bg-slate-400 text-slate-100" : "bg-slate-200 text-slate-600"
                      }`}
                    >
                      SENT
                    </span>
                  )}
                </div>
                <div className="text-xs leading-snug mt-0.5 line-clamp-2">
                  {r.lead.title}
                </div>
                <div className={`text-[10px] mt-1 flex items-center gap-1 ${isActive ? "opacity-80" : "text-slate-500"}`}>
                  {r.lead.school_name ?? "(no school)"}
                  {r.lead.school_tier != null && ` · t${r.lead.school_tier}`}
                  {isErr && " · ⚠ error"}
                </div>
              </button>
            );
          })}
        </aside>

        {/* Detail view */}
        <main>
          {active.error ? (
            <div className="bg-red-50 border border-red-200 rounded-lg p-6">
              <h2 className="text-base font-semibold text-red-900 mb-2 flex items-center gap-2">
                <AlertCircle className="w-5 h-5" /> Render failed for this lead
              </h2>
              <p className="text-sm text-red-700 font-mono whitespace-pre-wrap">{active.error}</p>
              <p className="text-xs text-red-600 mt-3">
                Most common: Gemini timeout / quota. Try reload, or pick another lead.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Parts list */}
              <div className="space-y-2">
                <h3 className="text-sm font-medium text-slate-700 mb-1">Parts (click any block)</h3>
                {(active.parts ?? []).map((part) => {
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

              {/* Mail-client-style preview — From / To / Subject header
                  + rendered body, like opening the email in Gmail. */}
              <div>
                <h3 className="text-sm font-medium text-slate-700 mb-2">Email preview</h3>
                <div className="bg-white border border-slate-200 rounded-md shadow-sm overflow-hidden">
                  {/* From / To / Subject envelope */}
                  <div className="bg-slate-50 border-b border-slate-200 px-4 py-3 space-y-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-[11px] uppercase tracking-wide text-slate-500 w-12 shrink-0">From</span>
                      <span className="text-[13px] text-slate-900">
                        {active.lead.assigned_rep.name} &lt;{active.lead.assigned_rep.name.toLowerCase()}@compute.miracleplus.com&gt;
                      </span>
                    </div>
                    <div className="flex items-baseline gap-2">
                      <span className="text-[11px] uppercase tracking-wide text-slate-500 w-12 shrink-0">To</span>
                      <span className="text-[13px] text-slate-900 font-mono">{active.lead.author_email}</span>
                    </div>
                    <div className="flex items-baseline gap-2 pt-1 border-t border-slate-200/50 mt-1">
                      <span className="text-[11px] uppercase tracking-wide text-slate-500 w-12 shrink-0">Subj</span>
                      <span className="text-[14px] font-semibold text-slate-900">
                        {active.rendered?.subject}
                      </span>
                    </div>
                  </div>
                  {/* Rendered body */}
                  <div
                    className="text-[14px] text-slate-800 leading-relaxed prose prose-sm max-w-none p-5"
                    dangerouslySetInnerHTML={{ __html: sanitizeHtml(active.rendered?.html ?? "") }}
                  />
                </div>
                {active.lead.assigned_rep.wechat && (
                  <div className="mt-2 text-[11px] text-slate-500">
                    WeChat: <span className="font-mono">{active.lead.assigned_rep.wechat}</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Part detail side panel */}
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
              {openPart.kind === "ai_generated" && active.intro_output && (
                <div>
                  <div className="text-xs font-medium text-slate-500 mb-1">Raw LLM output (pre-HTML-escape)</div>
                  <pre className="text-[11px] font-mono text-slate-700 leading-relaxed p-3 bg-purple-50 rounded border border-purple-200 whitespace-pre-wrap">{active.intro_output}</pre>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Two-stage approval bar (migration 066):
 *
 *   proposal → [Approve prose] → approved_draft → [Activate] → active
 *
 * Visible only when template.status is proposal or approved_draft.
 * Activate requires picking a segment (cn / overseas / edu / null).
 * On success, parent's load() is called to refresh the data.
 *
 * Why two stages: admin should be able to sign off on the WORDS
 * separately from the routing rule. Sometimes the prose is great
 * but it's the wrong segment to ship to.
 */
function ApprovalBar({
  template,
  onChanged,
}: {
  template: { id: string; name: string; status: string; segment_default: string | null };
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [segment, setSegment] = useState<string>(template.segment_default ?? "cn");

  const approveDraft = async () => {
    if (busy) return;
    setBusy("approve");
    try {
      const res = await fetch(`/api/templates/${template.id}/approve-draft`, { method: "POST", credentials: "include" });
      if (!res.ok) { const j = await res.json().catch(() => ({})); alert(`Failed: ${j.error ?? res.status}`); return; }
      onChanged();
    } finally { setBusy(null); }
  };

  const activate = async () => {
    if (busy) return;
    if (!confirm(`Activate this template for segment '${segment}'? It will replace the current active template for that segment.`)) return;
    setBusy("activate");
    try {
      const res = await fetch(`/api/templates/${template.id}/activate`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ segment_default: segment === "global" ? null : segment }),
      });
      if (!res.ok) { const j = await res.json().catch(() => ({})); alert(`Failed: ${j.error ?? res.status}`); return; }
      onChanged();
    } finally { setBusy(null); }
  };

  const reject = async () => {
    if (busy) return;
    if (!confirm(`Archive this proposal? It won't be considered for production.`)) return;
    setBusy("reject");
    try {
      // Re-using PATCH on slots route would be wrong (that's for prose
      // edits). Direct status flip via the same approve-draft endpoint
      // pattern but to 'archived' — there's no such endpoint, so do
      // the supabase write inline via /api/templates (existing legacy
      // delete handler is gentle here).
      // For now: send PUT to /api/templates with id + status=archived
      // would require building that. Simpler: use the activate path
      // backwards — admin removes via /templates list page DELETE.
      // Punt on reject for this round; user can ignore the proposal.
      alert("Reject flow not yet wired — leave as-is or contact admin to delete from DB.");
    } finally { setBusy(null); }
  };

  return (
    <div className="mb-4 p-4 bg-amber-50 border border-amber-300 rounded-lg">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="text-xs font-bold uppercase tracking-wide text-amber-700 mb-1">
            {template.status === "proposal" ? "审核 — 第一步" : "激活 — 第二步"}
          </div>
          <div className="text-sm text-amber-900">
            {template.status === "proposal"
              ? "Congress 起草. 看一遍 prose, 觉得 OK 就 approve. Approve 不会让 production 用 — 只是说文字过关."
              : "Prose 已 approved. 选一个 segment 然后 activate, 现有的 segment 老 template 会自动 archive."}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {template.status === "proposal" && (
            <button
              onClick={() => void approveDraft()}
              disabled={busy !== null}
              className="px-3 py-1.5 bg-amber-600 text-white text-sm rounded font-medium disabled:opacity-50"
            >
              {busy === "approve" ? "..." : "Approve prose"}
            </button>
          )}
          {template.status === "approved_draft" && (
            <>
              <select
                value={segment}
                onChange={(e) => setSegment(e.target.value)}
                className="text-sm border border-amber-300 rounded px-2 py-1.5"
                disabled={busy !== null}
              >
                <option value="cn">cn</option>
                <option value="overseas">overseas</option>
                <option value="edu">edu</option>
                <option value="global">global (no segment)</option>
              </select>
              <button
                onClick={() => void activate()}
                disabled={busy !== null}
                className="px-3 py-1.5 bg-emerald-600 text-white text-sm rounded font-medium disabled:opacity-50"
              >
                {busy === "activate" ? "..." : "Activate"}
              </button>
            </>
          )}
          <button
            onClick={() => void reject()}
            disabled={busy !== null}
            className="px-3 py-1.5 bg-white border border-slate-300 text-slate-700 text-sm rounded disabled:opacity-50"
          >
            Reject
          </button>
        </div>
      </div>
    </div>
  );
}
