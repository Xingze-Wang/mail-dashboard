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
import { Loader2, Send, SkipForward, ArrowLeft } from "lucide-react";
import { sanitizeHtml } from "@/lib/sanitize";
import { Lead } from "./types";
import { isAgeGated, leadAgeDays, MIN_AGE_DAYS } from "@/lib/policy";

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

function plainToHtml(text: string): string {
  // wrap each non-empty paragraph in <p>, preserve single newlines as <br />
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped
    .split(/\n{2,}/)
    .map((para) => `<p>${para.replace(/\n/g, "<br />")}</p>`)
    .join("");
}

function ageLabel(createdAt: string): string {
  const days = leadAgeDays(createdAt);
  if (days < 1) return `${Math.max(0, Math.floor(days * 24))}h old`;
  return `${Math.floor(days)}d old`;
}

export function ReviewPane({ leads, onExit, onSent, onSkipped, initialLeadId }: Props) {
  const ready = useMemo(() => leads.filter((l) => l.status === "ready"), [leads]);
  const [idx, setIdx] = useState(0);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [override, setOverride] = useState(false);
  const [sending, setSending] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lead = ready[idx];
  const gated = lead ? isAgeGated(lead.createdAt) : false;
  const canEmail = !!(lead && lead.authorEmail && lead.draftHtml);

  // Reset idx when the underlying slice shrinks below current cursor
  useEffect(() => {
    if (idx > 0 && idx >= ready.length) setIdx(Math.max(0, ready.length - 1));
  }, [ready.length, idx]);

  // Jump to the requested lead on first load if specified.
  useEffect(() => {
    if (!initialLeadId) return;
    const target = ready.findIndex((l) => l.id === initialLeadId);
    if (target >= 0) setIdx(target);
    // Only run on the first paint with a non-empty ready slice; subsequent
    // changes shouldn't yank the user away from where they are.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready.length > 0]);

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

  const doSend = useCallback(async () => {
    if (!lead || sending || !canEmail) return;
    if (gated && !override) {
      setError(`Lead is < ${MIN_AGE_DAYS}d old — flip the override toggle to send.`);
      return;
    }
    setSending(true);
    setError(null);
    try {
      // Save edited draft first (only if changed)
      const editedHtml = plainToHtml(body);
      if (subject !== (lead.draftSubject || "") || editedHtml !== (lead.draftHtml || "")) {
        await fetch(`/api/pipeline/${lead.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ draftSubject: subject, draftHtml: editedHtml }),
        });
      }
      const res = await fetch("/api/pipeline/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: lead.id, override: gated && override }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Send failed");
        return;
      }
      onSent(lead);
      advance();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setSending(false);
    }
  }, [lead, sending, canEmail, gated, override, subject, body, onSent, advance]);

  const doSkip = useCallback(async () => {
    if (!lead || skipping) return;
    setSkipping(true);
    try {
      await fetch(`/api/pipeline/${lead.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "skipped" }),
      });
      onSkipped(lead);
      advance();
    } finally {
      setSkipping(false);
    }
  }, [lead, skipping, onSkipped, advance]);

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
  }, [doSend, onExit, advance, back]);

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
        {gated && (
          <label className="dx-override-toggle" title={`Lead is ${ageLabel(lead.createdAt)}`}>
            <input
              type="checkbox"
              checked={override}
              onChange={(e) => setOverride(e.target.checked)}
            />
            Override 7-day rule ({ageLabel(lead.createdAt)})
          </label>
        )}
        <button
          type="button"
          className="dx-secondary"
          onClick={doSkip}
          disabled={skipping || sending}
        >
          <SkipForward />
          Skip
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
            <span>{ageLabel(lead.createdAt)}</span>
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
              </label>
              <textarea
                ref={bodyRef}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Write your message…"
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
