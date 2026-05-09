"use client";

/**
 * Review-mode focused split-pane.
 *
 * Left: paper context (title, authors, abstract, school/tier/score/date).
 * Right: editable draft (subject + body) — edit-then-send.
 * Top bar: position counter, Skip, Send, Override-7d toggle (when gated).
 *
 * Keyboard:
 *   J / ArrowDown — next ready lead
 *   K / ArrowUp   — previous ready lead
 *   Cmd/Ctrl+Enter — send current
 *   Escape         — exit to Browse
 *
 * After send/skip we auto-advance to the next ready lead in the supplied
 * `leads` slice. When the slice ends we render the "All caught up" empty
 * state with a "Back to Browse" button.
 *
 * Body field is plain text only — we strip lead.draftHtml down to text via
 * the same DOMPurify-backed sanitizer used by LeadRow, then a regex-based
 * tag stripper (no innerHTML round-trip). On send we wrap the edited text
 * in a minimal <p>-with-<br> HTML payload so existing send routes (which
 * expect `draft_html`) keep working.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Send, SkipForward, ArrowLeft, Flag, UserCheck, X } from "lucide-react";
import { sanitizeHtml } from "@/lib/sanitize";
import { Lead, shortDate } from "./types";
import { isAgeGated, leadAgeDays, MIN_AGE_DAYS } from "@/lib/policy";
import { lintBrand, findsNewHits, type BrandLintHit } from "@/lib/brand-lint";

/** Extracts a stable arxiv id from any of arxiv.org/abs/..., /pdf/..., with
 *  optional version suffix and .pdf extension. Returns null for non-arxiv URLs. */
function arxivIdFromUrl(url: string | null): string | null {
  if (!url) return null;
  const m = /arxiv\.org\/(?:abs|pdf)\/([^/?#]+?)(?:v\d+)?(?:\.pdf)?$/i.exec(url);
  return m ? m[1] : null;
}

function PaperEmbed({ pdfUrl }: { pdfUrl: string | null }) {
  if (!pdfUrl) return null;
  // ar5iv mirrors arxiv papers as HTML — renders in iframes where PDFs don't.
  const arxivId = arxivIdFromUrl(pdfUrl);
  const ar5ivUrl = arxivId ? `https://ar5iv.labs.arxiv.org/html/${arxivId}` : null;
  return (
    <div style={{ marginTop: 14, borderTop: "1px solid var(--dx-border-soft)", paddingTop: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--dx-text-3)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
          Full paper
        </span>
        <a href={pdfUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: "var(--dx-blue)" }}>
          Open PDF ↗
        </a>
      </div>
      {ar5ivUrl ? (
        <iframe
          src={ar5ivUrl}
          title="Paper"
          style={{ width: "100%", height: 500, border: "1px solid var(--dx-border-soft)", borderRadius: 6, background: "#fff" }}
          sandbox="allow-scripts allow-same-origin"
        />
      ) : (
        <a href={pdfUrl} target="_blank" rel="noopener noreferrer" className="dx-secondary">
          Open paper in new tab
        </a>
      )}
    </div>
  );
}

interface Props {
  leads: Lead[]; // filtered + sorted slice from the page
  onExit: () => void; // back to Browse
  onSent: (lead: Lead) => void; // refresh hook
  onSkipped: (lead: Lead) => void; // refresh hook
  initialLeadId?: string | null; // jump to a specific lead on mount
}

function htmlToPlainText(html: string): string {
  // Run through DOMPurify first, then strip tags via regex. We never set
  // innerHTML — the resulting string only ever lands in a <textarea>'s
  // value attribute (textContent), so XSS isn't reachable from here.
  const cleaned = sanitizeHtml(html);
  const decoded = cleaned
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n\n")
    .replace(/<\/div\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decoded
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Kept in sync with email-generator.ts — if the apply URL changes there,
// edited sends would silently fall back to plain text "申请" without a link.
// Duplication is deliberate: the client can't import a server-only module
// just for a string constant.
const APPLY_URL_CTA = "https://apply.miracleplus.com/?p=gpu&c=ib&r=4Xq0R&utm_source=em";

function plainToHtml(text: string): string {
  // wrap each non-empty paragraph in <p>, preserve single newlines as <br />
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  // Re-link the word 申请 (if it appears and isn't already in an href) so
  // edited sends don't lose the CTA the generator originally put there.
  // Only the first occurrence is linked — sales rarely writes "申请" twice
  // and we don't want to paint the whole email blue if they do.
  const withApplyLink = escaped.replace(
    /申请/,
    `<a href="${APPLY_URL_CTA}">申请</a>`,
  );
  // Wrap in a <body> with the same inline style as the generator's
  // template so the signature (and body) render at #333 in Gmail even
  // after the user's edits pass through the textarea.
  const paragraphs = withApplyLink
    .split(/\n{2,}/)
    .map((para) => `<p>${para.replace(/\n/g, "<br />")}</p>`)
    .join("");
  return `<html><head><meta charset="utf-8"></head><body style="font-family: sans-serif; font-size: 14px; line-height: 1.8; color: #333;">${paragraphs}</body></html>`;
}

function ageLabel(createdAt: string): string {
  const days = leadAgeDays(createdAt);
  if (days < 1) return `${Math.max(0, Math.floor(days * 24))}h old`;
  return `${Math.floor(days)}d old`;
}

/** Age of the *paper itself* (time since arXiv publish), distinct from
 *  ingest age. Used in the review-pane meta row — sales cares "how old is
 *  this paper" (driver of emailing timeliness), not "how long has it been
 *  sitting in our queue." Falls back to ingest age when publishedAt is
 *  missing so we never render an empty label. */
function paperAgeLabel(publishedAt: string | null, createdAt: string): string {
  return publishedAt ? ageLabel(publishedAt) : ageLabel(createdAt);
}

export function ReviewPane({ leads, onExit, onSent, onSkipped, initialLeadId }: Props) {
  const ready = useMemo(() => leads.filter((l) => l.status === "ready"), [leads]);
  const [idx, setIdx] = useState(0);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  // Brand-lint watcher: debounce-runs against subject + body every
  // 400ms of keystroke inactivity, fires a `brand-typo` event on any
  // NEW hit. HelpBot listens for this and does a one-shot wave + toast
  // so sales sees the correction even if the chat is closed. Keeping
  // state in a ref so the effect doesn't re-render the pane on every
  // keystroke; only the event dispatch matters.
  const brandLintRef = useRef<BrandLintHit[]>([]);
  useEffect(() => {
    const t = setTimeout(() => {
      const hits = lintBrand(`${subject}\n${body}`);
      const fresh = findsNewHits(brandLintRef.current, hits);
      brandLintRef.current = hits;
      if (fresh.length > 0 && typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("brand-typo", { detail: fresh[0] }));
      }
    }, 400);
    return () => clearTimeout(t);
  }, [subject, body]);
  const [override, setOverride] = useState(false);
  const [sending, setSending] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Daily 7-day-override quota for the current rep. Fetched on mount and
  // after every successful send so the counter stays honest without
  // needing a realtime channel. Null = quota not yet loaded; {cap:0} =
  // no quota to enforce (no rep session).
  const [quota, setQuota] = useState<{ used: number; cap: number; remaining: number } | null>(null);
  const refreshQuota = useCallback(async () => {
    try {
      const r = await fetch("/api/metrics/override-usage");
      if (!r.ok) return;
      const d = await r.json();
      setQuota({ used: d.used, cap: d.cap, remaining: d.remaining });
    } catch { /* non-fatal */ }
  }, []);
  useEffect(() => { void refreshQuota(); }, [refreshQuota]);

  const lead = ready[idx];
  const gated = lead ? isAgeGated(lead.createdAt) : false;
  const canEmail = !!(lead && lead.authorEmail && lead.draftHtml);

  // Publish the current lead on the window so the app-shell HelpBot can
  // read it when the user opens the assistant — this is how Paper Tutor
  // mode gets scoped to whichever paper sales is reviewing. We use a
  // window global (not context) because: (1) only one writer, (2) HelpBot
  // reads on-demand when its modal opens, so no subscribe-to-changes
  // needed, (3) avoids threading a context provider through the app shell
  // for one ephemeral piece of UI state.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (lead) {
      (window as unknown as { __currentReviewLead?: { id: string; title: string } }).__currentReviewLead = {
        id: lead.id,
        title: lead.title,
      };
    } else {
      delete (window as unknown as { __currentReviewLead?: unknown }).__currentReviewLead;
    }
    return () => {
      if (typeof window !== "undefined") {
        delete (window as unknown as { __currentReviewLead?: unknown }).__currentReviewLead;
      }
    };
  }, [lead]);

  // Reset idx when the underlying slice shrinks below current cursor
  useEffect(() => {
    if (idx > 0 && idx >= ready.length) setIdx(Math.max(0, ready.length - 1));
  }, [ready.length, idx]);

  // Jump to the requested lead whenever the deeplink changes OR the ready
  // slice first lands. The previous implementation dep-gated on
  // `[ready.length > 0]` (a boolean that never re-fires), so clicking a
  // specific lead row while already in Review mode silently dropped you on
  // idx=0 instead of the lead you clicked. Tracking `initialLeadId`
  // directly fixes that; a ref guard below prevents re-yanking the cursor
  // after the user navigates away with J/K.
  const jumpedToInitialRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialLeadId || ready.length === 0) return;
    // If we already honored this exact deeplink, don't yank the user back
    // every time `ready` refreshes (fetchLeads on send/skip rebuilds it).
    if (jumpedToInitialRef.current === initialLeadId) return;
    const target = ready.findIndex((l) => l.id === initialLeadId);
    if (target >= 0) {
      setIdx(target);
      jumpedToInitialRef.current = initialLeadId;
    }
  }, [initialLeadId, ready]);

  // Sync editor fields when current lead changes
  useEffect(() => {
    if (!lead) return;
    setSubject(lead.draftSubject || "");
    setBody(lead.draftHtml ? htmlToPlainText(lead.draftHtml) : "");
    setOverride(false);
    setError(null);
  }, [lead?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const advance = useCallback(() => {
    setIdx((i) => Math.min(i + 1, ready.length));
  }, [ready.length]);

  const back = useCallback(() => {
    setIdx((i) => Math.max(i - 1, 0));
  }, []);

  // Edit-reason modal state. Opens when sales hits Send AND the draft was
  // edited from the AI's original. Skippable.
  const [showEditModal, setShowEditModal] = useState(false);
  const [pendingEditReasons, setPendingEditReasons] = useState<Set<string>>(new Set());
  const [pendingEditNote, setPendingEditNote] = useState("");

  // Compare plain-text to plain-text (not HTML-to-HTML) — `body` is
  // initialized as htmlToPlainText(draftHtml), and the round-trip through
  // plainToHtml() never equals the original HTML, so comparing HTML would
  // mark every unedited send as "edited" and pop the reason modal every time.
  const isEdited = useMemo(() => {
    if (!lead) return false;
    const originalBody = lead.draftHtml ? htmlToPlainText(lead.draftHtml) : "";
    return subject !== (lead.draftSubject || "") || body !== originalBody;
  }, [lead, subject, body]);

  const requestSend = useCallback(() => {
    if (!lead || sending || !canEmail) return;
    if (gated && !override) {
      setError(`Lead is < ${MIN_AGE_DAYS}d old — flip the override toggle to send.`);
      return;
    }
    if (isEdited) {
      setPendingEditReasons(new Set());
      setPendingEditNote("");
      setShowEditModal(true);
    } else {
      void actuallySend([], "");
    }
  }, [lead, sending, canEmail, gated, override, isEdited]); // eslint-disable-line

  const actuallySend = useCallback(async (reasons: string[], note: string) => {
    if (!lead) return;
    setSending(true);
    setError(null);
    setShowEditModal(false);
    try {
      // If the user didn't edit the body, send the ORIGINAL draftHtml
      // untouched — the plain-text round-trip (htmlToPlainText → textarea →
      // plainToHtml) strips <a> tags and inline styles, which kills the
      // 申请 CTA link and the signature color. Only pay the round-trip cost
      // when the body actually changed.
      const editedHtml = isEdited ? plainToHtml(body) : (lead.draftHtml ?? plainToHtml(body));
      const res = await fetch("/api/pipeline/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: lead.id,
          override: gated && override,
          editedSubject: subject,
          editedHtml,
          editReasons: reasons.length ? reasons : null,
          editNote: note || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        // daily_override_limit comes back as 429 with a quota payload —
        // surface it distinctly so sales understands it's not a one-off
        // failure and won't recover on retry.
        if (data.code === "daily_override_limit" && data.quota) {
          setQuota({ used: data.quota.used, cap: data.quota.cap, remaining: 0 });
        }
        setError(data.error || "Send failed");
        return;
      }
      // Refresh the quota so the counter reflects the override we just
      // consumed (cheap — ~1 indexed COUNT). Best-effort; the next send
      // will correct any stale state anyway.
      if (gated && override) void refreshQuota();
      // NOTE: don't call advance() here. onSent() triggers a parent refetch
      // that drops this lead from the ready[] filter — the next ready lead
      // naturally slides into the current idx. Calling advance() *and*
      // refetching would skip ahead by 2 (looks like "sent two at once").
      onSent(lead);

      // Action-triggered chime probe (Dream #1). Fire-and-forget. If
      // the route returns a chime, broadcast a CustomEvent that the
      // global HelpBot listens for and renders as a nudge bubble.
      // Most calls return chime: null — silent skip is the design.
      void (async () => {
        try {
          const r = await fetch("/api/help/chime-in/check", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              trigger: "send_email",
              context: { lead_id: lead.id, subject },
            }),
          });
          if (!r.ok) return;
          const d = await r.json();
          if (d?.chime?.reason) {
            window.dispatchEvent(
              new CustomEvent("helper-action-chime", { detail: { reason: String(d.chime.reason) } }),
            );
          }
        } catch {
          /* fail-quiet */
        }
      })();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setSending(false);
    }
  }, [lead, gated, override, subject, body, isEdited, onSent, refreshQuota]);

  // Old name kept for the keyboard handler — wraps requestSend so Cmd+Enter
  // still triggers the same intercept.
  const doSend = requestSend;

  // saveStatus: gives the user feedback on whether their edits are
  // persisted. The previous behavior was: edits only persisted on
  // Skip/Send, AND only when isEdited was true. Several silent failure
  // modes resulted ('looked saved but wasn't' user reports). New
  // behavior: save on every navigation/blur, with a visible indicator.
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  // Reusable save: idempotent, safe to call repeatedly. Returns true
  // if save succeeded (or was a no-op because nothing was edited).
  const saveDraftIfEdited = useCallback(async (): Promise<boolean> => {
    if (!lead) return true;
    if (!isEdited) return true;
    setSaveStatus("saving");
    try {
      const res = await fetch(`/api/pipeline/${lead.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          draftSubject: subject,
          draftHtml: plainToHtml(body),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(`Save failed: ${data.error ?? `HTTP ${res.status}`}. Edits NOT saved.`);
        setSaveStatus("error");
        return false;
      }
      setSaveStatus("saved");
      // Auto-clear "saved" indicator after a couple seconds
      setTimeout(() => setSaveStatus((s) => (s === "saved" ? "idle" : s)), 2000);
      return true;
    } catch (e) {
      setError(`Save failed: ${e instanceof Error ? e.message : "Network error"}. Edits NOT saved.`);
      setSaveStatus("error");
      return false;
    }
  }, [lead, isEdited, subject, body]);

  const doSkip = useCallback(async () => {
    if (!lead || skipping) return;
    setSkipping(true);
    setError(null);
    try {
      // Skip = "save my edits (if any) and move on." It does NOT flip
      // status=skipped — the lead stays in 'ready' so sales can come
      // back to it. Terminal rejection is handled by Flag (soft→note
      // only, hard→blocklist + skip).
      const ok = await saveDraftIfEdited();
      if (!ok) return;
      // Move to next lead. Since status stays 'ready', the parent's
      // refetch won't drop this lead from the ready[] slice — so we
      // DO need to advance() manually here (unlike Send, which relies
      // on server-side status change to naturally drop it).
      onSkipped(lead);
      advance();
    } finally {
      setSkipping(false);
    }
  }, [lead, skipping, saveDraftIfEdited, onSkipped, advance]);

  // Save when navigating away from this lead (J/K/arrow buttons).
  // We trigger save on lead.id change BEFORE the sync effect runs.
  // Use a ref to capture the previous lead so we can save its draft.
  const prevLeadIdRef = useRef<string | null>(null);
  const prevSubjectRef = useRef<string>("");
  const prevBodyRef = useRef<string>("");
  useEffect(() => {
    // Capture current state for the navigation hook
    prevSubjectRef.current = subject;
    prevBodyRef.current = body;
  }, [subject, body]);
  useEffect(() => {
    const prevId = prevLeadIdRef.current;
    if (prevId && lead?.id && prevId !== lead.id) {
      // Navigated away from prevId. Save its edits using last-known
      // subject/body. Fire-and-forget — we don't block UI on it.
      const prevSubject = prevSubjectRef.current;
      const prevBody = prevBodyRef.current;
      void fetch(`/api/pipeline/${prevId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          draftSubject: prevSubject,
          draftHtml: plainToHtml(prevBody),
        }),
      }).catch(() => {
        // Non-fatal — user already moved on. The next save attempt
        // (Skip/Send) on that lead will catch it.
      });
    }
    prevLeadIdRef.current = lead?.id ?? null;
  }, [lead?.id]);

  // Keyboard shortcuts. We attach to window so they fire even when focus
  // is in the textarea — but Cmd/Ctrl+Enter is the only "active" shortcut
  // in that case (J/K/arrows would fight with normal typing).
  const subjectRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const isTyping =
        target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

      // If any modal is open, don't fire send/exit shortcuts — the
      // user might be typing a reason/note and the keystroke would
      // bypass the modal's validation. Let the modal own the
      // keyboard when it's up.
      if (showEditModal) {
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        doSend();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onExit();
        return;
      }
      if (isTyping) return;
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        advance();
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        back();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doSend, onExit, advance, back, showEditModal]);

  // Empty / done state
  if (ready.length === 0 || idx >= ready.length || !lead) {
    return (
      <div className="dx-empty" style={{ marginTop: 12 }}>
        <div className="dx-empty-glyph">OK</div>
        <div className="dx-empty-body">
          <div className="dx-empty-title">All caught up</div>
          <div className="dx-empty-text">
            No more ready leads in the current filter. Switch back to Browse to pick a different
            slice or run a scan.
          </div>
        </div>
        <div className="dx-empty-actions">
          <button className="dx-primary" type="button" onClick={onExit}>
            <ArrowLeft />
            Back to Browse
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="dx-review-bar">
        <span className="dx-review-pos">
          {idx + 1} of {ready.length} ready
        </span>
        <span className="dx-review-sub">
          <span className="dx-kbd">J</span> next · <span className="dx-kbd">K</span> prev ·{" "}
          <span className="dx-kbd">Cmd+Enter</span> send · <span className="dx-kbd">esc</span> exit
        </span>
        <div className="dx-review-spacer" />
        {gated && (() => {
          // When the rep has a real quota (cap>0) AND is out, we block the
          // override at the UI layer too — the server also rejects, but
          // disabling the checkbox prevents the sales person from staring
          // at a Send button that always errors.
          const quotaExhausted = !!quota && quota.cap > 0 && quota.remaining <= 0;
          const usageLabel = quota && quota.cap > 0
            ? ` · ${quota.used}/${quota.cap} used today`
            : "";
          return (
            <label
              className="dx-override-toggle"
              title={
                quotaExhausted
                  ? `今日 override 额度已用完 (${quota!.used}/${quota!.cap})。Beijing 00:00 重置。`
                  : `Lead is ${ageLabel(lead.createdAt)}${usageLabel ? " · quota" + usageLabel : ""}`
              }
              style={quotaExhausted ? { opacity: 0.55, cursor: "not-allowed" } : undefined}
            >
              <input
                type="checkbox"
                checked={override}
                disabled={quotaExhausted}
                onChange={(e) => setOverride(e.target.checked)}
              />
              Override 7-day rule ({ageLabel(lead.createdAt)}){usageLabel}
            </label>
          );
        })()}
        <button
          type="button"
          className="dx-secondary"
          onClick={doSkip}
          disabled={skipping || sending}
        >
          <SkipForward />
          {isEdited ? "Save & next" : "Next"}
        </button>
        <button
          type="button"
          className="dx-primary"
          onClick={doSend}
          disabled={!canEmail || sending || (gated && !override)}
          title={!canEmail ? "This lead has no draft or no email" : "Cmd/Ctrl + Enter"}
        >
          {sending ? <Loader2 className="animate-spin" /> : <Send />}
          Send
        </button>
        <button type="button" className="dx-ghost" onClick={onExit}>
          <ArrowLeft />
          Browse
        </button>
      </div>

      {error && (
        <div
          style={{
            marginBottom: 12,
            padding: "10px 14px",
            background: "#FEF2F2",
            border: "1px solid #FECACA",
            borderRadius: 8,
            color: "#991B1B",
            fontSize: 12.5,
          }}
        >
          {error}
        </div>
      )}

      <div className="dx-review">
        {/* LEFT — paper context */}
        <div className="dx-review-pane left">
          <div className="dx-review-meta">
            <span>arXiv</span>
            <span className="dx-meta-dot" />
            <span
              title={
                lead.publishedAt
                  ? `Paper published ${shortDate(lead.publishedAt)} · ingested ${ageLabel(lead.createdAt)} ago`
                  : `Ingested ${ageLabel(lead.createdAt)} ago`
              }
            >
              {paperAgeLabel(lead.publishedAt, lead.createdAt)}
            </span>
            {lead.leadTier && (
              <>
                <span className="dx-meta-dot" />
                <span>{lead.leadTier === "strong" ? "Strong" : "Normal"}</span>
              </>
            )}
            {lead.hIndex !== null && (
              <>
                <span className="dx-meta-dot" />
                <span>h-index {lead.hIndex}</span>
              </>
            )}
            {lead.citationCount !== null && (
              <>
                <span className="dx-meta-dot" />
                <span>{lead.citationCount.toLocaleString()} cites</span>
              </>
            )}
          </div>
          <h2>{lead.title}</h2>
          <div className="dx-review-meta">
            <strong style={{ color: "var(--dx-text-2)", fontWeight: 600 }}>
              {lead.authorName || "Unknown"}
            </strong>
            <span style={{ fontSize: 11, color: "var(--dx-text-3)" }}>
              (current recipient)
            </span>
            {lead.schoolName && (
              <>
                <span className="dx-meta-dot" />
                <span>{lead.schoolName}</span>
              </>
            )}
            {lead.authorEmail && (
              <>
                <span className="dx-meta-dot" />
                <span>{lead.authorEmail}</span>
              </>
            )}
          </div>
          <AuthorList authorsRaw={lead.authors} currentAuthor={lead.authorName} />
          <AuthorSwitcher
            leadId={lead.id}
            currentAuthor={lead.authorName}
            authorsRaw={lead.authors}
          />
          {lead.abstract ? (
            <div className="dx-review-abs">{lead.abstract}</div>
          ) : (
            <div className="dx-review-abs" style={{ color: "var(--dx-text-3)" }}>
              (No abstract on file.)
            </div>
          )}

          <PaperEmbed pdfUrl={lead.pdfUrl} />
        </div>

        {/* RIGHT — editable draft */}
        <div className="dx-review-pane right">
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
            <FlagButton leadId={lead.id} onSkipped={() => onSkipped(lead)} />
          </div>
          {!canEmail ? (
            <div style={{ color: "var(--dx-text-3)", fontSize: 13 }}>
              {lead.authorEmail
                ? "This lead has no draft yet — wait for enrichment to finish, then come back."
                : "This lead needs to be Promoted first — go back to Browse mode."}
            </div>
          ) : (
            <>
              <label
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  color: "var(--dx-text-3)",
                }}
              >
                Subject
              </label>
              <input
                ref={subjectRef}
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                onBlur={() => void saveDraftIfEdited()}
                placeholder="Subject"
              />
              <label
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  color: "var(--dx-text-3)",
                  marginTop: 4,
                }}
              >
                Body (plain text)
                {/*
                  Save indicator: lights up green when an explicit save
                  succeeded (via saveDraftIfEdited triggered on blur).
                  Critical for users to trust their edits stick — the
                  prior failure mode was 'edited then nothing visible
                  happens until I send/skip'.
                */}
                {saveStatus === "saving" && (
                  <span className="ml-2 text-[10px] text-slate-400">saving…</span>
                )}
                {saveStatus === "saved" && (
                  <span className="ml-2 text-[10px] text-emerald-600">✓ saved</span>
                )}
                {saveStatus === "error" && (
                  <span className="ml-2 text-[10px] text-red-600">save failed</span>
                )}
              </label>
              <textarea
                ref={bodyRef}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                onBlur={() => void saveDraftIfEdited()}
                placeholder="Write your message…"
              />
            </>
          )}
        </div>
      </div>

      {/* Edit-reason modal */}
      {showEditModal && (
        <EditReasonModal
          editDistance={approxEditDistance(lead?.draftHtml || "", plainToHtml(body))}
          reasons={pendingEditReasons}
          note={pendingEditNote}
          onReasonsChange={setPendingEditReasons}
          onNoteChange={setPendingEditNote}
          onConfirm={() => actuallySend(Array.from(pendingEditReasons), pendingEditNote)}
          onSkip={() => actuallySend([], "")}
          onCancel={() => setShowEditModal(false)}
        />
      )}
    </div>
  );
}

// ─────────── Edit reason modal ───────────

const EDIT_REASON_OPTIONS: Array<{ key: string; label: string; hint?: string }> = [
  { key: "ai_misunderstood", label: "AI 对论文理解不对" },
  { key: "format",           label: "格式 / 标点不舒服" },
  { key: "too_verbose",      label: "太啰嗦" },
  { key: "too_robotic",      label: "太套路 / 不像人话" },
  { key: "individual_taste", label: "想换说法（个人偏好）" },
];

function EditReasonModal({
  editDistance, reasons, note,
  onReasonsChange, onNoteChange, onConfirm, onSkip, onCancel,
}: {
  editDistance: number;
  reasons: Set<string>;
  note: string;
  onReasonsChange: (s: Set<string>) => void;
  onNoteChange: (s: string) => void;
  onConfirm: () => void;
  onSkip: () => void;
  onCancel: () => void;
}) {
  const toggle = (k: string) => {
    const next = new Set(reasons);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    onReasonsChange(next);
  };
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed", inset: 0, background: "rgba(10,10,10,0.45)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--card)", borderRadius: 12, padding: 24, maxWidth: 460, width: "92%",
          boxShadow: "0 20px 50px rgba(0,0,0,0.18)",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>You edited this draft</h3>
          <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
            {editDistance > 0 ? `${editDistance} char diff` : "minor tweak"}
          </span>
        </div>
        <p style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 6, marginBottom: 16 }}>
          Why? (optional, multi-select — helps us improve the AI prompt)
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
          {EDIT_REASON_OPTIONS.map((o) => (
            <label key={o.key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={reasons.has(o.key)}
                onChange={() => toggle(o.key)}
              />
              {o.label}
            </label>
          ))}
        </div>
        <textarea
          value={note}
          onChange={(e) => onNoteChange(e.target.value)}
          placeholder="Optional: anything else? (free text)"
          style={{
            width: "100%", minHeight: 60, padding: 8, border: "1px solid var(--border)",
            borderRadius: 6, fontSize: 12, fontFamily: "inherit", marginBottom: 14, boxSizing: "border-box",
          }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <button type="button" className="dx-ghost" onClick={onCancel}>Cancel</button>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="dx-secondary" onClick={onSkip}>Skip & send</button>
            <button type="button" className="dx-primary" onClick={onConfirm}>
              {reasons.size > 0 ? `Send (${reasons.size} tagged)` : "Send"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function approxEditDistance(a: string, b: string): number {
  if (!a && !b) return 0;
  if (a === b) return 0;
  const counts = new Map<string, number>();
  for (const c of a) counts.set(c, (counts.get(c) ?? 0) + 1);
  for (const c of b) counts.set(c, (counts.get(c) ?? 0) - 1);
  let diff = 0;
  for (const v of counts.values()) diff += Math.abs(v);
  return Math.floor(diff / 2);
}

/* ===========================================================================
 * AuthorSwitcher — dropdown of all authors from the paper, click to swap
 * recipient. Useful when scraper picked the last-author PI but we should
 * be emailing the first-author PhD student.
 * ======================================================================== */

function parseAuthorList(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Read-only display of every author on the paper, with the current
 *  recipient bolded and a 1st/last tag. Shown above the interactive
 *  AuthorSwitcher so sales can see co-authors without opening the dropdown. */
function AuthorList({
  authorsRaw,
  currentAuthor,
}: {
  authorsRaw: string | null;
  currentAuthor: string | null;
}) {
  const all = useMemo(() => parseAuthorList(authorsRaw), [authorsRaw]);
  // Single-author case: render a compact hint so sales understands why
  // there's no "Switch to first author" button. Previously we returned
  // null and the feature just looked absent — especially confusing when
  // an admin looking at a different multi-author lead sees the button
  // and sales on a single-author one doesn't.
  if (all.length <= 1) {
    return (
      <div style={{ marginTop: 8, fontSize: 11, color: "var(--dx-text-3)" }}>
        Single author — no switch needed.
      </div>
    );
  }
  const current = (currentAuthor ?? "").toLowerCase();
  return (
    <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.6, color: "var(--dx-text-2)" }}>
      <span
        style={{
          fontSize: 10,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: "var(--dx-text-3)",
          marginRight: 8,
        }}
      >
        All authors ({all.length})
      </span>
      {all.map((name, i) => {
        const isCurrent = current && name.toLowerCase() === current;
        const isFirst = i === 0;
        const isLast = i === all.length - 1 && all.length > 1;
        return (
          <span key={name + i}>
            {i > 0 && <span style={{ color: "var(--dx-text-3)" }}>, </span>}
            <span
              style={{
                fontWeight: isCurrent ? 600 : 400,
                color: isCurrent ? "var(--dx-text-1)" : "var(--dx-text-2)",
                background: isCurrent ? "var(--dx-blue-bg)" : "transparent",
                padding: isCurrent ? "1px 6px" : 0,
                borderRadius: isCurrent ? 4 : 0,
              }}
            >
              {isFirst && <span style={{ color: "var(--dx-blue)", fontWeight: 600, marginRight: 4 }}>1st</span>}
              {isLast && !isFirst && <span style={{ color: "var(--dx-text-3)", fontSize: 10, marginRight: 4 }}>last</span>}
              {name}
            </span>
          </span>
        );
      })}
    </div>
  );
}

function AuthorSwitcher({
  leadId,
  currentAuthor,
  authorsRaw,
}: {
  leadId: string;
  currentAuthor: string | null;
  authorsRaw: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [emailInput, setEmailInput] = useState("");
  const [chosenName, setChosenName] = useState<string | null>(null);
  const all = useMemo(() => parseAuthorList(authorsRaw), [authorsRaw]);
  if (all.length <= 1) return null; // nothing to switch to

  async function doSwitch(newAuthorName: string, newAuthorEmail?: string) {
    setSwitching(newAuthorName);
    setError(null);
    try {
      const r = await fetch("/api/lead/switch-author", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadId, newAuthorName, newAuthorEmail: newAuthorEmail || undefined }),
      });
      const d = await r.json();
      if (!r.ok) {
        setError(d.error ?? "Switch failed");
        return;
      }
      // Reload so the lead's freshly-cleared enrichment + new name show up
      // in every place (sidebar count, list row, this pane).
      window.location.reload();
    } finally {
      setSwitching(null);
    }
  }

  return (
    <div style={{ marginTop: 10 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 10px",
          fontSize: 11,
          fontWeight: 500,
          borderRadius: 999,
          border: "1px solid var(--dx-border-soft)",
          background: open ? "var(--dx-blue-bg)" : "transparent",
          color: open ? "var(--dx-blue)" : "var(--dx-text-2)",
          cursor: "pointer",
        }}
      >
        <UserCheck style={{ width: 12, height: 12 }} />
        Switch to first author?
        <span style={{ color: "var(--dx-text-3)" }}>({all.length} authors)</span>
      </button>

      {open && (
        <div
          style={{
            marginTop: 8,
            padding: 12,
            background: "var(--dx-card)",
            border: "1px solid var(--dx-border-soft)",
            borderRadius: 8,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div style={{ fontSize: 11, color: "var(--dx-text-3)", marginBottom: 2 }}>
            Pick the right recipient. We&apos;ll re-target this lead and clear
            enrichment so the next step picks up the new author&apos;s data.
          </div>
          {chosenName ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 12 }}>
                Switching to <b>{chosenName}</b>. Optional — paste their email
                if you have it (otherwise we keep the existing email and you
                can edit before sending):
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  type="email"
                  placeholder="newauthor@school.edu (optional)"
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  style={{ flex: 1, padding: "6px 10px", fontSize: 12, border: "1px solid var(--dx-border-soft)", borderRadius: 6 }}
                />
                <button
                  onClick={() => doSwitch(chosenName, emailInput.trim())}
                  disabled={!!switching}
                  className="dx-primary"
                  style={{ fontSize: 12, padding: "6px 12px" }}
                >
                  {switching ? "Switching…" : "Confirm"}
                </button>
                <button
                  onClick={() => { setChosenName(null); setEmailInput(""); }}
                  className="dx-secondary"
                  style={{ fontSize: 12, padding: "6px 10px" }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {all.map((author, i) => {
                const isCurrent = currentAuthor && author.toLowerCase() === currentAuthor.toLowerCase();
                return (
                  <button
                    key={author + i}
                    onClick={() => !isCurrent && setChosenName(author)}
                    disabled={!!isCurrent}
                    style={{
                      textAlign: "left",
                      padding: "6px 10px",
                      fontSize: 12,
                      border: "1px solid " + (isCurrent ? "var(--dx-border-soft)" : "transparent"),
                      borderRadius: 6,
                      background: isCurrent ? "var(--dx-bg)" : "transparent",
                      color: isCurrent ? "var(--dx-text-3)" : "var(--dx-text-1)",
                      cursor: isCurrent ? "default" : "pointer",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <span>
                      {i === 0 && <span style={{ color: "var(--dx-blue)", fontWeight: 600, marginRight: 6 }}>1st</span>}
                      {i === all.length - 1 && i !== 0 && <span style={{ color: "var(--dx-text-3)", fontSize: 10, marginRight: 6 }}>last</span>}
                      {author}
                    </span>
                    {isCurrent && <span style={{ fontSize: 10, color: "var(--dx-text-3)" }}>current</span>}
                  </button>
                );
              })}
            </div>
          )}

          {error && (
            <div style={{ fontSize: 11, color: "#dc2626" }}>{error}</div>
          )}
        </div>
      )}
    </div>
  );
}

/* ===========================================================================
 * FlagButton — small "🚩" trigger that opens a modal for sales to flag
 * this lead with one of 6 categories. Posts to /api/lead/correct.
 * ======================================================================== */

// Sales is reliable on: did we get the RIGHT person, did the email READ
// well, is the direction tag CORRECT. Sales is NOT reliable on: will this
// person need compute, will they convert — those need real outcome data.
// Hints below set sales expectations honestly so they don't think
// "bad_compute" is gospel.
const FLAG_OPTIONS: { type: string; label: string; hint: string; skipsLead: boolean }[] = [
  { type: "low_quality_email",      label: "Email 写得不好",      hint: "草稿不像人话 / 错别字 / AI 味重 — 训练 email-quality scorer",   skipsLead: false },
  { type: "wrong_author",           label: "作者搞错了",          hint: "应该发给一作不是教授（用上面 Switch 更直接）",                  skipsLead: false },
  { type: "wrong_direction",        label: "方向标错了",          hint: "我们的方向分类不对，会修正",                                   skipsLead: false },
  { type: "right_lead_wrong_pitch", label: "Lead 对，话术不对",   hint: "Persuasion angle 错了 — 训练 angle picker",                    skipsLead: false },
  { type: "bad_compute",            label: "不该需要算力（直觉）", hint: "你的判断会被记录给 admin 看，但不直接喂训练（因为 sales 看 abstract 不一定准）", skipsLead: true  },
  { type: "good_lead",              label: "👍 直觉是好 lead",    hint: "你的判断会被记录，但 lead 好坏最终看实际转化数据",              skipsLead: false },
];

function FlagButton({ leadId, onSkipped }: { leadId: string; onSkipped: () => void }) {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<typeof FLAG_OPTIONS[number] | null>(null);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  // 'soft' = note only; 'hard' = block sender + skip lead. Hard requires
  // senior or admin role.
  const [severity, setSeverity] = useState<"soft" | "hard">("soft");
  const [role, setRole] = useState<string>("sales");

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => setRole(d.role ?? "sales"))
      .catch(() => {});
  }, []);

  const canHardFlag = role === "admin" || role === "senior";

  const [submitError, setSubmitError] = useState<string | null>(null);
  async function submit() {
    if (!chosen) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      const r = await fetch("/api/lead/correct", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          leadId,
          type: chosen.type,
          reason: reason.trim() || undefined,
          severity,
          skip: chosen.skipsLead && severity === "soft",
        }),
      });
      if (!r.ok) {
        // Previously: silently failed and modal closed like success.
        // That's why "sales marked flags but settings showed nothing" —
        // the insert never actually happened.
        const body = await r.json().catch(() => ({}));
        setSubmitError(body.error ?? `Save failed (HTTP ${r.status})`);
        return;
      }
      setDone(true);
      const willSkip = severity === "hard" || chosen.skipsLead;
      if (willSkip) {
        setTimeout(() => { setOpen(false); setDone(false); setChosen(null); setReason(""); setSeverity("soft"); onSkipped(); }, 800);
      } else {
        setTimeout(() => { setOpen(false); setDone(false); setChosen(null); setReason(""); setSeverity("soft"); }, 900);
      }
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Network error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Flag this lead — wrong author / bad direction / etc."
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          padding: "4px 10px",
          fontSize: 11,
          // Solid muted-amber so the button reads as a real action.
          // Previously transparent + soft border made it look disabled
          // and reps missed it entirely → too few flag signals → drift
          // training had nothing to learn from.
          color: "#92400E",
          background: "#FEF3C7",
          border: "1px solid #FCD34D",
          borderRadius: 999,
          cursor: "pointer",
          fontWeight: 500,
        }}
      >
        <Flag style={{ width: 11, height: 11 }} />
        Flag
      </button>

      {open && (
        <div
          onClick={() => !submitting && setOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 50,
            padding: 24,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(440px, 92vw)",
              background: "var(--dx-card)",
              borderRadius: 12,
              border: "1px solid var(--dx-border-soft)",
              padding: 18,
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>
                {done ? "✓ Saved" : chosen ? `Flag: ${chosen.label}` : "Flag this lead"}
              </div>
              <button
                onClick={() => !submitting && setOpen(false)}
                style={{ background: "transparent", border: 0, color: "var(--dx-text-3)", cursor: "pointer", padding: 4, lineHeight: 0 }}
              >
                <X style={{ width: 16, height: 16 }} />
              </button>
            </div>
            {done ? (
              <div style={{ fontSize: 12, color: "var(--dx-text-2)" }}>
                Thanks — this signal will go into the next training run.
              </div>
            ) : !chosen ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {FLAG_OPTIONS.map((o) => (
                  <button
                    key={o.type}
                    onClick={() => setChosen(o)}
                    style={{
                      textAlign: "left",
                      padding: "8px 10px",
                      fontSize: 12.5,
                      border: "1px solid var(--dx-border-soft)",
                      borderRadius: 6,
                      background: "var(--dx-bg)",
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ fontWeight: 500 }}>{o.label}</div>
                    <div style={{ fontSize: 11, color: "var(--dx-text-3)", marginTop: 2 }}>
                      {o.hint}
                      {o.skipsLead && <span style={{ marginLeft: 6, color: "#d97706" }}>· also skips lead</span>}
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <>
                <div style={{ fontSize: 11.5, color: "var(--dx-text-3)", lineHeight: 1.5 }}>{chosen.hint}</div>

                {/* Severity selector — always visible so sales sees what hard does */}
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <SeverityChoice
                    value="soft" current={severity} setSeverity={setSeverity}
                    title="Note only"
                    body="Just record this signal — admin reviews later."
                    enabled
                  />
                  <SeverityChoice
                    value="hard" current={severity} setSeverity={setSeverity}
                    title="🚫 Don't send to this person"
                    body={canHardFlag
                      ? "Adds them to the blocklist permanently + skips this lead. Use for: wrong identity / opted out / portfolio company / legal."
                      : "Senior or admin role required for blocklist. Ask Xingze to promote you if you need this."}
                    enabled={canHardFlag}
                  />
                </div>

                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={severity === "hard" ? "Required for hard flag: WHY block this person?" : "Optional: more detail (≤500 chars)"}
                  rows={3}
                  style={{
                    width: "100%",
                    padding: "8px 10px",
                    fontSize: 12,
                    border: "1px solid var(--dx-border-soft)",
                    borderRadius: 6,
                    boxSizing: "border-box",
                    resize: "vertical",
                  }}
                />
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <button onClick={() => setChosen(null)} className="dx-secondary" style={{ fontSize: 12, padding: "6px 12px" }}>
                    Back
                  </button>
                  <button
                    onClick={submit}
                    disabled={submitting || (severity === "hard" && !reason.trim())}
                    className="dx-primary"
                    style={{
                      fontSize: 12, padding: "6px 14px",
                      display: "inline-flex", alignItems: "center", gap: 6,
                      background: severity === "hard" ? "#dc2626" : undefined,
                      borderColor: severity === "hard" ? "#dc2626" : undefined,
                    }}
                  >
                    {submitting ? <Loader2 style={{ width: 13, height: 13 }} className="spin" /> : <Flag style={{ width: 13, height: 13 }} />}
                    {submitting ? "Saving…" : severity === "hard" ? "Block & skip" : chosen.skipsLead ? "Save & skip" : "Save"}
                  </button>
                </div>
                {submitError && (
                  <div style={{ marginTop: 8, padding: "8px 10px", background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 6, fontSize: 12, color: "#991B1B" }}>
                    {submitError}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function SeverityChoice({
  value, current, setSeverity, title, body, enabled,
}: {
  value: "soft" | "hard";
  current: "soft" | "hard";
  setSeverity: (v: "soft" | "hard") => void;
  title: string;
  body: string;
  enabled: boolean;
}) {
  const active = value === current;
  return (
    <button
      onClick={() => enabled && setSeverity(value)}
      disabled={!enabled}
      style={{
        textAlign: "left",
        padding: "8px 10px",
        fontSize: 12,
        border: "1px solid " + (active && enabled ? (value === "hard" ? "#dc2626" : "var(--dx-blue)") : "var(--dx-border-soft)"),
        borderRadius: 6,
        background: active && enabled ? (value === "hard" ? "rgba(220,38,38,0.06)" : "var(--dx-blue-bg)") : "transparent",
        cursor: enabled ? "pointer" : "not-allowed",
        opacity: enabled ? 1 : 0.55,
      }}
    >
      <div style={{ fontWeight: 500, color: value === "hard" && active ? "#dc2626" : "var(--dx-text-1)" }}>{title}</div>
      <div style={{ fontSize: 11, color: "var(--dx-text-3)", marginTop: 2, lineHeight: 1.4 }}>{body}</div>
    </button>
  );
}
