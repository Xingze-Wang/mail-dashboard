"use client";

/**
 * Paper-shaped lead card for the design-D pipeline stream.
 *
 * Renders a single arXiv pipeline_leads row using the dx-* card geometry.
 * Adapts inner content (draft snippet vs enriching placeholder vs sent
 * follow-up) based on lead.status. Click expands inline editor for the
 * draft.
 *
 * draftHtml is sanitized with sanitizeHtml() (DOMPurify) before any DOM
 * insertion. The plaintext snippet is also derived through a sanitize +
 * strip pass so we never inject raw HTML into the snippet either.
 */

import { memo, useMemo, useState } from "react";
import {
  Loader2, Send, Pencil, X, ExternalLink, Mail, Clock,
} from "lucide-react";
import { sanitizeHtml } from "@/lib/sanitize";
import { Lead, Rep, canSend } from "./types";
import { colorForRep, initialsFor } from "./repColors";
import { isAgeGated, leadAgeDays, MIN_AGE_DAYS } from "@/lib/policy";

interface Props {
  lead: Lead;
  reps: Rep[];
  isExpanded: boolean;
  isExcluded: boolean;
  isSending: boolean;
  showStatusBadge: boolean;
  onToggleExpand: (id: string) => void;
  onToggleExclude: (id: string) => void;
  onSend: (lead: Lead, override?: boolean) => void;
  onSkip: (id: string) => void;
  onRepChange: (leadId: string, repId: number) => void;
  onSaveEdit: (id: string, subject: string, html: string) => Promise<void>;
}

/* ── Helpers ─────────────────────────────────────────────────────── */

function htmlToText(html: string): string {
  // sanitizeHtml() runs DOMPurify; we then strip remaining tags for the
  // 2-line preview. Output is plain text only — never reaches innerHTML.
  const cleaned = sanitizeHtml(html);
  if (typeof document === "undefined") {
    return cleaned.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  const div = document.createElement("div");
  div.innerHTML = cleaned;
  return (div.textContent || div.innerText || "").replace(/\s+/g, " ").trim();
}

function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "future";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  return `${mo}mo ago`;
}

const MIN_PAPER_AGE_MS = 7 * 86_400_000;

function isPaperRipening(publishedAt: string | null): boolean {
  if (!publishedAt) return false;
  const t = Date.parse(publishedAt);
  if (isNaN(t)) return false;
  return Date.now() - t < MIN_PAPER_AGE_MS;
}

function statusFor(
  lead: Lead,
):
  | "ready"
  | "ripening"
  | "drafting"
  | "sent"
  | "replied"
  | "enriching"
  | "discovered"
  | "skipped"
  | "new" {
  if (lead.status === "replied") return "replied";
  if (lead.status === "sent") return "sent";
  if (lead.status === "skipped") return "skipped";
  if (lead.status === "queued" || lead.status === "drafting") return "drafting";
  if (lead.status === "ready") {
    if (isPaperRipening(lead.publishedAt)) return "ripening";
    return "ready";
  }
  if (lead.status === "new" && (!lead.draftHtml || !lead.authorEmail)) return "enriching";
  return "new";
}

function statusLabel(s: string): string {
  switch (s) {
    case "ready":      return "Ready";
    case "ripening":   return "Ripening";
    case "drafting":   return "Drafting";
    case "sent":       return "Sent";
    case "replied":    return "Replied";
    case "enriching":  return "Enriching";
    case "discovered": return "Discovered";
    case "skipped":    return "Skipped";
    case "new":        return "New";
    default:           return s;
  }
}

/* ── Component ───────────────────────────────────────────────────── */

function LeadRowInner({
  lead, reps, isExpanded, isExcluded, isSending, showStatusBadge,
  onToggleExpand, onToggleExclude, onSend, onSkip, onRepChange, onSaveEdit,
}: Props) {
  const sendCheck = canSend(lead);
  const status = statusFor(lead);
  const tierClass = lead.leadTier === "strong" ? "strong" : "normal";

  const draftSnippet = useMemo(() => {
    if (!lead.draftHtml) return "";
    const text = htmlToText(lead.draftHtml);
    return text.length > 200 ? text.slice(0, 200) + "…" : text;
  }, [lead.draftHtml]);

  // sanitizedDraft is fed to dangerouslySetInnerHTML for the expanded
  // preview only. DOMPurify strips scripts/handlers; matches existing
  // .pipeline-email-preview convention used elsewhere in the app.
  const sanitizedDraft = useMemo(
    () => (lead.draftHtml ? sanitizeHtml(lead.draftHtml) : ""),
    [lead.draftHtml],
  );

  const [editing, setEditing] = useState(false);
  const [editSubject, setEditSubject] = useState(lead.draftSubject || "");
  const [editHtml, setEditHtml] = useState(lead.draftHtml || "");
  const [saving, setSaving] = useState(false);
  const [overrideArmed, setOverrideArmed] = useState(false);

  // 7-day age-gate (UX hint — server is the final word). Anchored on
  // created_at, distinct from canSend()'s published_at check.
  const ageGated = isAgeGated(lead.createdAt);
  const ageDaysFloor = Math.floor(leadAgeDays(lead.createdAt));

  const startEdit = () => {
    setEditSubject(lead.draftSubject || "");
    setEditHtml(lead.draftHtml || "");
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      await onSaveEdit(lead.id, editSubject, editHtml);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const currentRep = reps.find((r) => r.id === lead.assignedRepId) ?? null;
  const repName = currentRep?.name ?? null;
  const repColor = colorForRep(repName);

  const hasMeta =
    lead.citationCount !== null ||
    lead.hIndex !== null ||
    lead.publishedAt ||
    lead.sentAt;

  const cardClass = ["dx-card", status, isExcluded && "is-excluded"]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cardClass}>
      {/* Head: badges + meta */}
      <div className="dx-card-head">
        <span className="dx-src-badge arxiv">
          <span className="dx-src-dot" />
          arXiv
        </span>
        {showStatusBadge && (
          <span className={`dx-status-badge ${status}`}>
            <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="6" /></svg>
            {statusLabel(status)}
          </span>
        )}
        <span className={`dx-tier-badge ${tierClass}`}>
          {tierClass === "strong" ? "Strong" : "Normal"}
        </span>
        {hasMeta && (
          <span className="dx-head-meta">
            {lead.citationCount !== null && lead.citationCount > 0 && (
              <>
                <span>{lead.citationCount.toLocaleString()} cites</span>
                {(lead.hIndex !== null || lead.publishedAt) && <span className="dx-meta-dot" />}
              </>
            )}
            {lead.hIndex !== null && (
              <>
                <span>h-index {lead.hIndex}</span>
                {(lead.publishedAt || lead.sentAt) && <span className="dx-meta-dot" />}
              </>
            )}
            {lead.sentAt ? (
              <span>sent {relativeTime(lead.sentAt)}</span>
            ) : lead.publishedAt ? (
              <span>{relativeTime(lead.publishedAt)}</span>
            ) : null}
          </span>
        )}
      </div>

      {/* Title */}
      <h3 className="dx-card-title">{lead.title}</h3>

      {/* Author row */}
      <div className="dx-author-row">
        <span className="dx-au-name">{lead.authorName || "Unknown"}</span>
        {lead.schoolName && (
          <>
            <span className="dx-au-sep">·</span>
            <span className="dx-au-org">{lead.schoolName}</span>
          </>
        )}
        <span className="dx-au-sep">·</span>
        <span
          className="dx-au-email"
          style={status === "enriching" && !lead.authorEmail ? { color: "var(--dx-text-3)" } : undefined}
        >
          {lead.authorEmail || "resolving email…"}
        </span>
      </div>

      {/* Draft snippet (only if we have a draft and not currently editing) */}
      {!editing && draftSnippet && (
        <div className="dx-draft-snippet">
          <div className="dx-draft-label">
            <Pencil style={{ width: 10, height: 10 }} />
            Draft{repName ? ` · ${repName}` : ""}
          </div>
          {lead.draftSubject && <div className="dx-draft-subj">{lead.draftSubject}</div>}
          <div className="dx-draft-body">{draftSnippet}</div>
        </div>
      )}

      {/* Inline editor */}
      {editing && (
        <div className="dx-edit-area">
          <input
            type="text"
            value={editSubject}
            onChange={(e) => setEditSubject(e.target.value)}
            placeholder="Subject"
          />
          <textarea
            value={editHtml}
            onChange={(e) => setEditHtml(e.target.value)}
            rows={10}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={save} disabled={saving} className="dx-primary">
              {saving ? "Saving…" : "Save draft"}
            </button>
            <button type="button" onClick={() => setEditing(false)} className="dx-secondary">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Expanded preview (sanitized HTML — DOMPurify in sanitizeHtml). */}
      {isExpanded && !editing && sanitizedDraft && (
        <div
          className="pipeline-email-preview"
          style={{
            marginBottom: 14,
            borderRadius: 8,
            background: "#FFFFFF",
            border: "1px solid var(--dx-border-soft)",
            padding: 16,
            fontSize: 13,
          }}
          dangerouslySetInnerHTML={{ __html: sanitizedDraft }}
        />
      )}

      {/* Foot */}
      <div className="dx-card-foot">
        <span className="dx-foot-meta">
          {status === "drafting" ? (
            <span style={{ color: "var(--dx-slate)" }}>
              <Loader2 style={{ display: "inline", width: 12, height: 12, marginRight: 4 }} className="animate-spin" />
              Drafting email…
            </span>
          ) : status === "ripening" ? (
            <span style={{ color: "var(--dx-amber)", display: "inline-flex", alignItems: "center", gap: 4 }}>
              <Clock style={{ width: 12, height: 12 }} />
              Paper &lt; 7d old — hold off unless you have a reason
            </span>
          ) : status === "enriching" ? (
            <span style={{ color: "var(--dx-amber)" }}>
              <Loader2 style={{ display: "inline", width: 12, height: 12, marginRight: 4 }} className="animate-spin" />
              Enrichment in progress
            </span>
          ) : status === "sent" ? (
            <>
              Sent by
              <span className="dx-rep-chip">
                <span className="dx-rp-dot" style={{ background: repColor }}>
                  {repName ? initialsFor(repName).slice(0, 1) : "?"}
                </span>
                {repName ?? "Unassigned"}
              </span>
              · awaiting reply
            </>
          ) : status === "replied" ? (
            <>
              Owned by
              <span className="dx-rep-chip">
                <span className="dx-rp-dot" style={{ background: repColor }}>
                  {repName ? initialsFor(repName).slice(0, 1) : "?"}
                </span>
                {repName ?? "Unassigned"}
              </span>
            </>
          ) : (
            <>
              Assigned to
              {reps.length > 0 ? (
                <select
                  className="dx-select-light"
                  value={lead.assignedRepId ?? ""}
                  onChange={(e) => onRepChange(lead.id, parseInt(e.target.value, 10))}
                  style={{ marginLeft: 4 }}
                  aria-label="Reassign rep"
                >
                  <option value="">Unassigned</option>
                  {reps.map((r) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
              ) : (
                <span className="dx-rep-chip">{repName ?? "Unassigned"}</span>
              )}
            </>
          )}
          {!sendCheck.ok && sendCheck.availableIn && status === "ready" && (
            <span style={{ marginLeft: 8, color: "var(--dx-amber)", display: "inline-flex", alignItems: "center", gap: 4 }}>
              <Clock style={{ width: 11, height: 11 }} />
              {sendCheck.availableIn}
            </span>
          )}
        </span>

        <div className="dx-foot-actions" onClick={(e) => e.stopPropagation()}>
          {lead.pdfUrl && (
            <a
              href={lead.pdfUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="dx-ghost"
              title="Open arXiv paper"
            >
              <ExternalLink />
              arXiv
            </a>
          )}

          {status === "ripening" && (
            <>
              <button type="button" className="dx-ghost" onClick={() => onSkip(lead.id)}>
                Skip
              </button>
              <button type="button" className="dx-secondary" onClick={isExpanded ? startEdit : () => onToggleExpand(lead.id)}>
                <Mail />
                {isExpanded ? "Edit draft" : "View draft"}
              </button>
              {overrideArmed ? (
                <>
                  <button type="button" className="dx-ghost" onClick={() => setOverrideArmed(false)} disabled={isSending}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="dx-primary"
                    disabled={isSending}
                    onClick={() => onSend(lead, true)}
                    title="Override the paper-age rule"
                    style={{ background: "var(--dx-amber)" }}
                  >
                    {isSending ? <Loader2 className="animate-spin" /> : <Send />}
                    Send anyway
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="dx-secondary"
                  disabled={isSending}
                  onClick={() => setOverrideArmed(true)}
                  title="Paper is less than 7 days old"
                >
                  <Send />
                  Override & send
                </button>
              )}
            </>
          )}

          {status === "ready" && (
            <>
              <button type="button" className="dx-ghost" onClick={() => onSkip(lead.id)}>
                Skip
              </button>
              {!editing ? (
                <button type="button" className="dx-secondary" onClick={isExpanded ? startEdit : () => onToggleExpand(lead.id)}>
                  <Mail />
                  {isExpanded ? "Edit draft" : "View draft"}
                </button>
              ) : null}
              <button
                type="button"
                className="dx-secondary"
                onClick={() => onToggleExclude(lead.id)}
                title={isExcluded ? "Include in batch" : "Exclude from batch"}
                style={{ padding: "6px 8px" }}
              >
                <X style={{ width: 13, height: 13 }} />
              </button>
              {ageGated ? (
                overrideArmed ? (
                  <>
                    <button
                      type="button"
                      className="dx-ghost"
                      onClick={() => setOverrideArmed(false)}
                      disabled={isSending}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="dx-primary"
                      disabled={isSending}
                      onClick={() => onSend(lead, true)}
                      title={`Override the ${MIN_AGE_DAYS}-day rule`}
                    >
                      {isSending ? <Loader2 className="animate-spin" /> : <Send />}
                      Override and send
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="dx-secondary"
                    disabled={isSending}
                    onClick={() => setOverrideArmed(true)}
                    title={`${ageDaysFloor}d old — needs override`}
                  >
                    <Send />
                    {ageDaysFloor}d old · override
                  </button>
                )
              ) : (
                <button
                  type="button"
                  className="dx-primary"
                  disabled={!sendCheck.ok || isSending}
                  onClick={() => onSend(lead)}
                >
                  {isSending ? <Loader2 className="animate-spin" /> : <Send />}
                  Send
                </button>
              )}
            </>
          )}

          {status === "sent" && (
            <>
              <button type="button" className="dx-ghost" onClick={() => onToggleExpand(lead.id)}>
                {isExpanded ? "Hide" : "Open thread"}
              </button>
              <button type="button" className="dx-secondary">Follow up</button>
            </>
          )}

          {status === "replied" && (
            <>
              <button type="button" className="dx-ghost" onClick={() => onToggleExpand(lead.id)}>
                {isExpanded ? "Hide" : "Open thread"}
              </button>
              <button type="button" className="dx-primary">WeChat</button>
            </>
          )}

          {status === "enriching" && (
            <>
              <button type="button" className="dx-ghost" onClick={() => onSkip(lead.id)}>Skip</button>
              <button type="button" className="dx-secondary">Manual lookup</button>
            </>
          )}

          {status === "skipped" && (
            <button type="button" className="dx-ghost" onClick={() => onToggleExpand(lead.id)}>
              {isExpanded ? "Hide details" : "View"}
            </button>
          )}

          {status === "new" && (
            <button type="button" className="dx-ghost" onClick={() => onToggleExpand(lead.id)}>
              {isExpanded ? "Hide" : "View"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export const LeadRow = memo(LeadRowInner);
