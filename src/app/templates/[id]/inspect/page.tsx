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
  assigned_rep: { name: string; wechat: string; sender_email: string | null };
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

// Maps the inspect-page short slot id ("subject", "intro", etc.) to the
// email_templates column name the slots API expects. Edits POST/PATCH
// this column name so the validator accepts them.
const SLOT_TO_DB_COLUMN: Record<string, string> = {
  subject: "subject_format",
  greeting: "greeting_format",
  intro: "intro_prompt",
  rep_intro: "rep_intro_format",
  school_pitch: "school_pitch_format",
  cta_signoff: "cta_signoff_format",
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

      {/* Routing + performance strip — answers "who does this template
          actually go to, and how has it performed?". For active
          templates: real numbers from /api/templates/performance.
          For proposals: shows the routing decision Activate would make
          (segment_default + assigned rep) and an empty perf state. */}
      <RoutingAndPerfStrip
        templateId={data.template.id}
        templateStatus={data.template.status}
        segmentDefault={data.template.segment_default}
      />

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
            // ONE email with parts labeled inline. The left margin
            // shows a small label for each block (Subject / Greeting /
            // Intro / Rep intro / School pitch / CTA), colored by
            // kind (fixed-text / ai-generated / etc). Clicking any
            // labeled block opens the slide-in panel with prompt details.
            // No parallel-column preview — the rendered text IS the
            // preview, the labels just annotate which slot is which.
            //
            // The slot order matches template-assembler's send-time render:
            // subject → greeting → intro → rep_intro → school_pitch → cta_signoff.
            <div className="max-w-3xl">
              <div className="bg-white border border-slate-200 rounded-md shadow-sm overflow-hidden">
                {/* Envelope: From / To stays as a single header — that's
                    routing context, not template content. */}
                <div className="bg-slate-50 border-b border-slate-200 px-5 py-3 space-y-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[11px] uppercase tracking-wide text-slate-500 w-12 shrink-0">From</span>
                    <span className="text-[13px] text-slate-900">
                      {active.lead.assigned_rep.name}
                      {active.lead.assigned_rep.sender_email && (
                        <span className="text-slate-500"> &lt;{active.lead.assigned_rep.sender_email}&gt;</span>
                      )}
                    </span>
                  </div>
                  <div className="flex items-baseline gap-2">
                    <span className="text-[11px] uppercase tracking-wide text-slate-500 w-12 shrink-0">To</span>
                    <span className="text-[13px] text-slate-900 font-mono">{active.lead.author_email}</span>
                  </div>
                </div>

                {/* The email itself, with each slot labeled in the
                    left margin. Click any labeled row → slide-in
                    panel with prompt + source format. */}
                <div className="p-5 space-y-4">
                  {(active.parts ?? []).map((part) => {
                    const style = KIND_STYLE[part.kind];
                    return (
                      <div
                        key={part.slot}
                        className="grid grid-cols-[110px_1fr] gap-4 cursor-pointer rounded hover:bg-slate-50 -mx-2 px-2 py-1.5"
                        onClick={() => setOpenPart(part)}
                      >
                        {/* Label gutter */}
                        <div className="pt-1 text-right">
                          <div className="flex items-center gap-1 justify-end">
                            <style.Icon className={`w-3 h-3 ${style.text}`} />
                            <span className={`text-[10px] font-bold uppercase tracking-wide ${style.text}`}>
                              {SLOT_LABEL[part.slot] ?? part.slot}
                            </span>
                          </div>
                          <div className={`text-[9px] uppercase tracking-wide mt-0.5 ${style.text} opacity-60`}>
                            {style.label}
                          </div>
                        </div>
                        {/* Content — looks like the real email */}
                        <div>
                          {part.slot === "subject" ? (
                            <div className="text-[15px] font-semibold text-slate-900 leading-tight">
                              {part.rendered}
                            </div>
                          ) : (
                            <div
                              className="text-[14px] text-slate-800 leading-relaxed prose prose-sm max-w-none"
                              dangerouslySetInnerHTML={{ __html: sanitizeHtml(part.rendered) }}
                            />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
              {active.lead.assigned_rep.wechat && (
                <div className="mt-3 text-[11px] text-slate-500">
                  WeChat appended at send time: <span className="font-mono">{active.lead.assigned_rep.wechat}</span>
                </div>
              )}
              <div className="mt-3 text-[11px] text-slate-400">
                Click any labeled block to see its prompt / source format / selection reason.
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
                <div className="text-xs font-medium text-slate-500 mb-1">Rendered preview</div>
                <div
                  className="text-[12px] text-slate-700 leading-relaxed prose prose-sm max-w-none p-3 bg-slate-50 rounded border border-slate-200"
                  dangerouslySetInnerHTML={{ __html: sanitizeHtml(openPart.rendered) }}
                />
              </div>
              {/* INLINE EDITOR — admin asked for it. Loads the current
                  source_format into a textarea; Save → POSTs to the
                  slots queue endpoint. Non-admins get the same UI but
                  POST routes to the diff queue (template_edits) for
                  review. AI-generated slots (kind='ai_generated') edit
                  the PROMPT, not the rendered output. */}
              {SLOT_TO_DB_COLUMN[openPart.slot] && id && data?.template && (
                <SlotEditor
                  templateId={id}
                  templateStatus={data.template.status}
                  slotKey={SLOT_TO_DB_COLUMN[openPart.slot]}
                  slotLabel={SLOT_LABEL[openPart.slot] ?? openPart.slot}
                  initialValue={openPart.source_format ?? openPart.resolved_prompt ?? ""}
                  isAiSlot={openPart.kind === "ai_generated"}
                  onSaved={() => {
                    setOpenPart(null);
                    void load();
                  }}
                />
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
 * Compact strip showing (a) where this template gets routed
 * (segment default + per-rep override + active competitors) and (b)
 * how its rates have moved over the past 14 vs 28 days so admins can
 * see whether the proposal is beating the baseline before activating.
 * Lives just under the page header and above the approval bar.
 */
function RoutingAndPerfStrip({
  templateId, templateStatus, segmentDefault,
}: { templateId: string; templateStatus: string; segmentDefault: string | null }) {
  const [perf, setPerf] = useState<{
    sent: number; clicked: number; wechat: number;
    clickRate: number; wechatRate: number;
    clickRateBaseline: number | null;
  } | null>(null);
  const [routing, setRouting] = useState<{ active_for_segment: string | null; competitors: number }>({
    active_for_segment: null, competitors: 0,
  });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // (a) per-template performance over a 28d window
      try {
        const r = await fetch(`/api/templates/performance?days=28`, { credentials: "include" });
        if (r.ok) {
          const j = await r.json();
          // Find this template in the list. Performance API returns
          // all templates; we filter client-side because the route
          // doesn't accept a single-template filter.
          const mine = (j.rows ?? []).find((x: { id: string }) => x.id === templateId);
          if (mine && !cancelled) {
            setPerf({
              sent: mine.sent ?? 0,
              clicked: mine.clicked ?? 0,
              wechat: mine.wechat ?? 0,
              clickRate: mine.clickRate ?? 0,
              wechatRate: mine.wechatRate ?? 0,
              clickRateBaseline: j.orgBaseline?.clickRate ?? null,
            });
          }
        }
      } catch {/* best effort */}
      // (b) routing competitors — how many other templates would
      // serve the same segment if this got activated
      try {
        const r = await fetch(`/api/templates/library`, { credentials: "include" });
        if (r.ok) {
          const j = await r.json();
          const seg = segmentDefault ?? null;
          const competitors = (j.rows ?? []).filter((x: { id: string; status: string; segment_default: string | null }) =>
            x.id !== templateId && x.status === "active" && x.segment_default === seg,
          );
          const me = (j.rows ?? []).find((x: { id: string }) => x.id === templateId);
          if (!cancelled) setRouting({
            active_for_segment: me?.status === "active" ? (seg ?? "global") : null,
            competitors: competitors.length,
          });
        }
      } catch {/* best effort */}
      if (!cancelled) setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [templateId, segmentDefault]);

  if (!loaded) return null;

  const fmtPct = (x: number | null | undefined) => x == null ? "—" : `${(x * 100).toFixed(1)}%`;
  const lift = perf && perf.clickRateBaseline ? perf.clickRate - perf.clickRateBaseline : null;
  const liftColor = lift == null ? "text-slate-500" : lift > 0.005 ? "text-emerald-700" : lift < -0.005 ? "text-red-700" : "text-slate-500";
  const liftSign = lift == null ? "" : lift > 0 ? "+" : "";

  return (
    <div className="mb-3 p-3 bg-slate-50 border border-slate-200 rounded flex flex-wrap items-center gap-x-6 gap-y-2 text-[12px]">
      {/* Routing — who this goes to */}
      <div>
        <span className="text-slate-500 uppercase tracking-wide text-[10px] mr-1.5">Routes to</span>
        <span className="font-mono">{segmentDefault ?? "global"}</span>
        {routing.competitors > 0 && (
          <span className="ml-1.5 text-amber-700 bg-amber-100 border border-amber-200 rounded px-1.5 py-0.5 text-[10px]">
            {routing.competitors} active competitor{routing.competitors > 1 ? "s" : ""} same segment
          </span>
        )}
      </div>
      <div className="text-slate-300">·</div>
      {/* Performance — what's happening with it */}
      {perf && perf.sent > 0 ? (
        <>
          <div>
            <span className="text-slate-500 uppercase tracking-wide text-[10px] mr-1.5">Sent (28d)</span>
            <span className="font-medium">{perf.sent}</span>
          </div>
          <div>
            <span className="text-slate-500 uppercase tracking-wide text-[10px] mr-1.5">CTR</span>
            <span className="font-medium">{fmtPct(perf.clickRate)}</span>
            {lift != null && perf.sent >= 20 && (
              <span className={`ml-1.5 ${liftColor}`}>
                ({liftSign}{(lift * 100).toFixed(1)}pp vs org baseline {fmtPct(perf.clickRateBaseline)})
              </span>
            )}
            {perf.sent < 20 && perf.sent > 0 && (
              <span className="ml-1.5 text-slate-400">(low n — need ≥20 sends for lift)</span>
            )}
          </div>
          <div>
            <span className="text-slate-500 uppercase tracking-wide text-[10px] mr-1.5">WeChat conv</span>
            <span className="font-medium">{perf.wechat}</span>
          </div>
        </>
      ) : (
        <div className="text-slate-500 italic">
          {templateStatus === "proposal" || templateStatus === "approved_draft"
            ? "No real sends yet — performance will populate once Activated."
            : "No sends in the last 28 days."}
        </div>
      )}
    </div>
  );
}

/**
 * Inline editor for a single template slot, rendered inside the slide-in
 * detail panel. Behavior depends on template status:
 *   - status='active'    → can't edit in place (would change live emails).
 *                          Shows a "Fork" CTA pointing at /api/templates/fork.
 *   - status='approved_draft' or 'proposal' → PATCH the slot directly
 *                          via /api/templates/[id]/slots (admin-only).
 *   - non-admin user      → POST to the slots queue (template_edits row,
 *                          status='pending') so admin can review.
 *
 * The server enforces all of this — the client just hits the right verb
 * and surfaces the resulting message.
 */
function SlotEditor({
  templateId, templateStatus, slotKey, slotLabel, initialValue, isAiSlot, onSaved,
}: {
  templateId: string;
  templateStatus: string;
  slotKey: string;
  slotLabel: string;
  initialValue: string;
  isAiSlot: boolean;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // Re-key the local state when the parent opens a DIFFERENT slot.
  useEffect(() => { setValue(initialValue); setMsg(null); }, [initialValue, slotKey]);

  const dirty = value !== initialValue;
  const isActive = templateStatus === "active";

  const save = async (verb: "PATCH" | "POST") => {
    setBusy(true);
    setMsg(null);
    try {
      const body: Record<string, string> = { [slotKey]: value };
      const res = await fetch(`/api/templates/${templateId}/slots`, {
        method: verb,
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg(`Save failed (${res.status}): ${j.error ?? "unknown"}`);
        return;
      }
      setMsg(verb === "PATCH" ? "Saved ✓" : "Queued for admin review ✓");
      setTimeout(onSaved, 600);
    } catch (e) {
      setMsg(`Network error: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border border-slate-200 rounded p-3 bg-white">
      <div className="text-xs font-medium text-slate-500 mb-1.5">
        Edit {slotLabel} {isAiSlot ? "(prompt fed to LLM)" : "(template source)"}
      </div>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={Math.min(20, Math.max(4, value.split("\n").length + 1))}
        disabled={busy}
        className="w-full text-[12px] font-mono p-2.5 bg-slate-50 border border-slate-300 rounded resize-y"
      />
      <div className="flex items-center gap-2 mt-2">
        {isActive ? (
          <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
            Active templates can&apos;t be edited in place — fork via /api/templates/fork.
          </div>
        ) : (
          <>
            <button
              disabled={!dirty || busy}
              onClick={() => save("PATCH")}
              className="text-[12px] px-3 py-1 rounded bg-slate-900 text-white font-medium disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy ? "Saving…" : "Save (admin)"}
            </button>
            <button
              disabled={!dirty || busy}
              onClick={() => save("POST")}
              className="text-[12px] px-3 py-1 rounded border border-slate-300 text-slate-700 font-medium disabled:opacity-40 disabled:cursor-not-allowed"
              title="Queue this edit for admin review"
            >
              Submit for review
            </button>
            <button
              disabled={!dirty || busy}
              onClick={() => setValue(initialValue)}
              className="text-[11px] text-slate-500"
            >
              Reset
            </button>
          </>
        )}
        {msg && <span className={`text-[11px] ml-auto ${msg.startsWith("Save") || msg.startsWith("Queued") ? "text-emerald-700" : "text-red-700"}`}>{msg}</span>}
      </div>
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
  // Default to whatever the proposal already declares. NULL → "global"
  // not "cn" — defaulting null to cn silently turned every global
  // proposal into cn-only on activate. The dropdown's "global (no
  // segment)" option carries the same semantics as null in DB.
  const [segment, setSegment] = useState<string>(template.segment_default ?? "global");
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

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

  const submitReject = async () => {
    if (busy) return;
    const reason = rejectReason.trim();
    if (reason.length < 10) {
      alert("Reason needs to be at least 10 chars. This becomes congress evidence — be specific so the synthesizer doesn't re-propose the same kind of change.");
      return;
    }
    setBusy("reject");
    try {
      const res = await fetch(`/api/templates/${template.id}/reject`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      if (!res.ok) { const j = await res.json().catch(() => ({})); alert(`Failed: ${j.error ?? res.status}`); return; }
      setRejectOpen(false);
      setRejectReason("");
      onChanged();
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
            onClick={() => setRejectOpen(true)}
            disabled={busy !== null}
            className="px-3 py-1.5 bg-white border border-slate-300 text-slate-700 text-sm rounded disabled:opacity-50"
          >
            Reject
          </button>
        </div>
      </div>

      {/* Reject modal — admin must give a reason. The reason becomes
          congress evidence next week. Without specificity, congress
          will re-propose the same kind of change. */}
      {rejectOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
          onClick={() => !busy && setRejectOpen(false)}
        >
          <div
            className="bg-white rounded-lg shadow-xl max-w-lg w-full p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-semibold text-slate-900 mb-2">
              Reject this proposal
            </h2>
            <p className="text-xs text-slate-500 mb-3 leading-relaxed">
              你的理由会进 next congress 的 evidence pack —
              synthesizer 看到 "上次提了类似 X, 被 admin 用 Y 理由拒了" 就不会再提同类的.
              所以越具体越好 (e.g. "校园 tier3 cn group 转化率反而比 tier1 高,
              不要按 tier 分人去推送" 比 "不好" 强 100 倍).
            </p>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="为什么拒? (≥10 字)"
              rows={5}
              className="w-full text-sm border border-slate-300 rounded p-2 focus:outline-none focus:ring-2 focus:ring-amber-300"
              autoFocus
            />
            <div className="text-[10px] text-slate-400 mt-1">
              {rejectReason.trim().length} / 1500 chars
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => { setRejectOpen(false); setRejectReason(""); }}
                disabled={busy !== null}
                className="px-3 py-1.5 text-sm rounded border border-slate-300 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => void submitReject()}
                disabled={busy !== null || rejectReason.trim().length < 10}
                className="px-3 py-1.5 text-sm rounded bg-red-600 text-white disabled:opacity-50"
              >
                {busy === "reject" ? "Rejecting..." : "Reject + archive"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
