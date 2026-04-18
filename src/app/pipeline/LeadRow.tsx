"use client";

// Email draft preview uses dangerouslySetInnerHTML; sanitized via sanitizeHtml() (DOMPurify).
import { memo, useMemo, useState } from "react";
import {
  Clock, Loader2, ChevronDown, ChevronUp, Pencil, X,
  Activity, BookOpen, Send, ExternalLink, Mail,
} from "lucide-react";
import { sanitizeHtml } from "@/lib/sanitize";
import {
  Lead, Rep,
  canSend,
  paperAge, shortDate,
} from "./types";

interface Props {
  lead: Lead;
  reps: Rep[];
  isExpanded: boolean;
  isExcluded: boolean;
  isSending: boolean;
  showStatusBadge: boolean;
  onToggleExpand: (id: string) => void;
  onToggleExclude: (id: string) => void;
  onSend: (lead: Lead) => void;
  onSkip: (id: string) => void;
  onRepChange: (leadId: string, repId: number) => void;
  onSaveEdit: (id: string, subject: string, html: string) => Promise<void>;
}

const AVATAR_PALETTES = [
  { bg: "linear-gradient(135deg, #DBEAFE, #BFDBFE)", color: "#1D4ED8" },
  { bg: "linear-gradient(135deg, #FCE7F3, #FBCFE8)", color: "#BE185D" },
  { bg: "linear-gradient(135deg, #D1FAE5, #A7F3D0)", color: "#047857" },
  { bg: "linear-gradient(135deg, #FEF3C7, #FDE68A)", color: "#92400E" },
  { bg: "linear-gradient(135deg, #E0E7FF, #C7D2FE)", color: "#4338CA" },
  { bg: "linear-gradient(135deg, #FFE4E6, #FECDD3)", color: "#BE123C" },
];

function paletteFor(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTES[h % AVATAR_PALETTES.length];
}

function initials(name: string | null) {
  if (!name) return "??";
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function statusLabel(s: string) {
  switch (s) {
    case "new":      return "New";
    case "ready":    return "Ready";
    case "sent":     return "Contacted";
    case "replied":  return "Qualified";
    case "skipped":  return "Skipped";
    default:         return s;
  }
}

function LeadRowInner({
  lead, reps, isExpanded, isExcluded, isSending, showStatusBadge,
  onToggleExpand, onToggleExclude, onSend, onSkip, onRepChange, onSaveEdit,
}: Props) {
  const sendCheck = canSend(lead);
  const directions = useMemo(
    () => lead.matchedDirections?.split(",").filter(Boolean) || [],
    [lead.matchedDirections],
  );
  // sanitizeHtml runs DOMPurify on lead.draftHtml before it touches the DOM.
  const sanitized = useMemo(
    () => (lead.draftHtml ? sanitizeHtml(lead.draftHtml) : ""),
    [lead.draftHtml],
  );

  const [editing, setEditing] = useState(false);
  const [editSubject, setEditSubject] = useState(lead.draftSubject || "");
  const [editHtml, setEditHtml] = useState(lead.draftHtml || "");
  const [saving, setSaving] = useState(false);

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

  const palette = paletteFor(lead.authorEmail || lead.id);
  const tierClass = lead.leadTier === "strong" ? "strong" : "normal";
  const computeLevel = lead.computeLevel && lead.computeLevel !== "none" ? lead.computeLevel : null;
  const cardClass = [
    "lead-card",
    isExcluded && "is-excluded",
    isExpanded && "is-expanded",
  ].filter(Boolean).join(" ");

  const labelTiny = { fontSize: 10, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 4 };

  return (
    <div className={cardClass}>
      <div className="cursor-pointer" onClick={() => onToggleExpand(lead.id)}>
        {/* ── Top row: badges + title ── */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            {showStatusBadge && (
              <span className={`badge-status ${lead.status}`}>{statusLabel(lead.status)}</span>
            )}
            {computeLevel && (
              <span className={`badge-compute ${computeLevel}`}>{computeLevel}</span>
            )}
            <span className={`badge-tier ${tierClass}`}>
              {tierClass === "strong" ? "Strong" : "Normal"}
            </span>
          </div>
          <h3 className="lead-title" style={{ flex: 1, minWidth: 0 }}>
            {lead.title}
          </h3>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggleExpand(lead.id); }}
            style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--text-tertiary)" }}
            aria-label={isExpanded ? "Collapse" : "Expand"}
          >
            {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
        </div>

        {/* ── Bottom row: author + pills + actions ── */}
        <div
          className="lead-card-body"
          style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 20, flexWrap: "wrap" }}
        >
          <div className="lead-meta" style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div className="author-avatar" style={{ background: palette.bg, color: palette.color }}>
                {initials(lead.authorName)}
              </div>
              <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: "#1A1A1A", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {lead.authorName || "Unknown"}
                </span>
                <span style={{ fontSize: 11.5, color: "var(--text-tertiary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {lead.authorEmail}
                  {lead.schoolName && ` · ${lead.schoolName}`}
                </span>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {lead.hIndex !== null && (
                <span className={`pill ${lead.hIndex >= 20 ? "high-h" : ""}`}>
                  <Activity />
                  h-index {lead.hIndex}
                </span>
              )}
              {lead.citationCount !== null && lead.citationCount > 0 && (
                <span className="pill">
                  <BookOpen />
                  {lead.citationCount.toLocaleString()} citations
                </span>
              )}
              {!sendCheck.ok && sendCheck.availableIn && (
                <span className="pill" style={{ color: "#B45309", borderColor: "#FDE68A", background: "#FFFBEB" }}>
                  <Clock />
                  {sendCheck.availableIn}
                </span>
              )}
            </div>
          </div>

          <div
            className="lead-actions"
            style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}
            onClick={(e) => e.stopPropagation()}
          >
            {directions.length > 0 && (
              <div style={{ display: "flex", gap: 6 }}>
                {directions.slice(0, 2).map((d) => (
                  <span key={d} className="direction-tag">{d}</span>
                ))}
              </div>
            )}

            {reps.length > 0 && (
              <select
                className="rep-select"
                value={lead.assignedRepId ?? ""}
                onChange={(e) => onRepChange(lead.id, parseInt(e.target.value))}
              >
                {reps.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
            )}

            {lead.status === "ready" && (
              <button
                type="button"
                onClick={() => onSend(lead)}
                disabled={!sendCheck.ok || isSending}
                className="btn-send"
              >
                {isSending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send />}
                Send
              </button>
            )}

            {lead.status === "ready" && sendCheck.ok && (
              <button
                type="button"
                onClick={() => onToggleExclude(lead.id)}
                className="btn"
                style={{ padding: "6px 8px" }}
                title={isExcluded ? "Include in batch" : "Exclude from batch"}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── Expanded panel ── */}
      {isExpanded && (
        <div className="animate-row-expand" style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--border-light)" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 32px", marginBottom: 16 }}>
            <div>
              <p style={labelTiny}>Contact</p>
              <p style={{ fontSize: 13, color: "#1A1A1A" }}>{lead.authorEmail}</p>
            </div>
            <div>
              <p style={labelTiny}>Semantic Scholar</p>
              {lead.s2AuthorId ? (
                <a
                  href={`https://www.semanticscholar.org/author/${lead.s2AuthorId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 13, color: "#2563EB" }}
                >
                  Profile <ExternalLink className="h-3 w-3" />
                </a>
              ) : (
                <p style={{ fontSize: 13, color: "var(--text-tertiary)" }}>Not found</p>
              )}
            </div>
            {lead.hIndex !== null && (
              <div>
                <p style={labelTiny}>h-index</p>
                <p style={{ fontFamily: "var(--font-heading)", fontSize: 22, fontWeight: 600, color: "#1A1A1A" }}>{lead.hIndex}</p>
              </div>
            )}
            {lead.citationCount !== null && (
              <div>
                <p style={labelTiny}>Total Citations</p>
                <p style={{ fontFamily: "var(--font-heading)", fontSize: 22, fontWeight: 600, color: "#1A1A1A" }}>{lead.citationCount.toLocaleString()}</p>
              </div>
            )}
          </div>

          {lead.abstract && (
            <div style={{ paddingTop: 12, borderTop: "1px solid var(--border-light)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <p style={{ ...labelTiny, marginBottom: 0 }}>Latest Paper</p>
                {lead.pdfUrl && (
                  <a
                    href={lead.pdfUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 11, color: "#2563EB" }}
                  >
                    arXiv <ExternalLink className="h-2.5 w-2.5" />
                  </a>
                )}
              </div>
              <p style={{ fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.6 }}>
                {lead.abstract.slice(0, 400)}{lead.abstract.length > 400 ? "…" : ""}
              </p>
            </div>
          )}

          {lead.computeReason && (
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border-light)" }}>
              <p style={labelTiny}>Compute Signal</p>
              <p style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>{lead.computeReason}</p>
            </div>
          )}

          <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border-light)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <p style={{ ...labelTiny, marginBottom: 0, display: "inline-flex", alignItems: "center", gap: 6 }}>
                <Mail className="h-3 w-3" />
                Email Draft
              </p>
              <div style={{ display: "flex", gap: 12 }}>
                {lead.status === "ready" && !editing && (
                  <button
                    type="button"
                    onClick={startEdit}
                    style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--text-secondary)", background: "transparent", border: "none", cursor: "pointer" }}
                  >
                    <Pencil className="h-3 w-3" />
                    Edit
                  </button>
                )}
                {lead.status === "ready" && (
                  <button
                    type="button"
                    onClick={() => onSkip(lead.id)}
                    style={{ fontSize: 12, color: "var(--text-tertiary)", background: "transparent", border: "none", cursor: "pointer" }}
                  >
                    Skip
                  </button>
                )}
              </div>
            </div>

            {editing ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <input
                  type="text"
                  value={editSubject}
                  onChange={(e) => setEditSubject(e.target.value)}
                  placeholder="Subject"
                  style={{ padding: "8px 12px", fontSize: 13, border: "1px solid var(--border)", borderRadius: 6, background: "var(--card)" }}
                />
                <textarea
                  value={editHtml}
                  onChange={(e) => setEditHtml(e.target.value)}
                  rows={10}
                  style={{ padding: "8px 12px", fontSize: 12, fontFamily: "ui-monospace, SFMono-Regular, monospace", border: "1px solid var(--border)", borderRadius: 6, background: "var(--card)", resize: "none" }}
                />
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" onClick={save} disabled={saving} className="btn btn-primary">
                    {saving ? "Saving…" : "Save"}
                  </button>
                  <button type="button" onClick={() => setEditing(false)} className="btn">
                    Cancel
                  </button>
                </div>
              </div>
            ) : sanitized ? (
              <>
                <p style={{ fontSize: 12.5, color: "#1A1A1A", marginBottom: 8 }}>Subject: {lead.draftSubject}</p>
                <div
                  className="pipeline-email-preview"
                  style={{ borderRadius: 8, background: "#FFFFFF", border: "1px solid var(--border-light)", padding: 16, fontSize: 13 }}
                  dangerouslySetInnerHTML={{ __html: sanitized }}
                />
              </>
            ) : (
              <p style={{ fontSize: 12.5, color: "var(--text-tertiary)", fontStyle: "italic" }}>No draft generated yet</p>
            )}
          </div>

          {lead.sentAt && (
            <div style={{ marginTop: 12, paddingTop: 8, borderTop: "1px solid var(--border-light)", fontSize: 11, color: "#16A34A" }}>
              Sent {shortDate(lead.sentAt)} · created {shortDate(lead.createdAt)} · age {paperAge(lead.publishedAt).text}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export const LeadRow = memo(LeadRowInner);
