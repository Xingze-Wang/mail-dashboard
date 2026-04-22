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
      const editedHtml = plainToHtml(body);
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
  }, [lead, gated, override, subject, body, onSent, advance]);

  // Old name kept for the keyboard handler — wraps requestSend so Cmd+Enter
  // still triggers the same intercept.
  const doSend = requestSend;

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

  async function submit() {
    if (!chosen) return;
    setSubmitting(true);
    try {
      const r = await fetch("/api/lead/correct", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          leadId,
          type: chosen.type,
          reason: reason.trim() || undefined,
          skip: chosen.skipsLead,
        }),
      });
      if (r.ok) {
        setDone(true);
        if (chosen.skipsLead) {
          // briefly show success, then advance
          setTimeout(() => { setOpen(false); setDone(false); setChosen(null); setReason(""); onSkipped(); }, 700);
        } else {
          setTimeout(() => { setOpen(false); setDone(false); setChosen(null); setReason(""); }, 900);
        }
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Flag this lead"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          padding: "4px 10px",
          fontSize: 11,
          color: "var(--dx-text-3)",
          background: "transparent",
          border: "1px solid var(--dx-border-soft)",
          borderRadius: 999,
          cursor: "pointer",
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
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Optional: more detail (≤500 chars)"
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
                    disabled={submitting}
                    className="dx-primary"
                    style={{ fontSize: 12, padding: "6px 14px", display: "inline-flex", alignItems: "center", gap: 6 }}
                  >
                    {submitting ? <Loader2 style={{ width: 13, height: 13 }} className="spin" /> : <Flag style={{ width: 13, height: 13 }} />}
                    {submitting ? "Saving…" : chosen.skipsLead ? "Save & skip" : "Save"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
