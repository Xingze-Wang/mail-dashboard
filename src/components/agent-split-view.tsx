"use client";

import { useEffect, useState, useCallback } from "react";
import { X, Save, Loader2, ExternalLink } from "lucide-react";

/**
 * Full-screen overlay: paper PDF on the left, editable draft on the
 * right. Opens when the helper's `open_split_view` action is
 * confirmed. Ephemeral — no route, no history entry. Close with Esc
 * or the X button.
 *
 * Save path: PATCHes /api/pipeline/[id] with draftSubject + draftHtml
 * (plain-text body wrapped in <p> tags, mirroring how ReviewPane's
 * save works). Does NOT send; send stays in ReviewPane where the
 * age-gate banner + quota counter live.
 */

interface SplitViewData {
  leadId: string;
  title: string;
  authors: string | null;
  pdfUrl: string | null;
  abstract: string | null;
  authorName: string | null;
  authorEmail: string | null;
  draftSubject: string | null;
  draftHtml: string | null;
  status: string;
}

function htmlToPlain(html: string): string {
  // Strip tags and collapse whitespace. Matches ReviewPane's cheap
  // round-trip so what the rep sees here is what they'd see there.
  return html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/\n{3,}/g, "\n\n").trim();
}
function plainToHtml(text: string): string {
  // Minimal: wrap paragraphs in <p>. Good enough for server-side
  // render; DOMPurify at display time scrubs anything unexpected.
  const paras = text.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`);
  return paras.join("\n");
}

export function AgentSplitView({ data, onClose }: { data: SplitViewData; onClose: () => void }) {
  const [subject, setSubject] = useState(data.draftSubject ?? "");
  const [body, setBody] = useState(data.draftHtml ? htmlToPlain(data.draftHtml) : "");
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);

  // Close on Escape, but not while saving — the network error would
  // be lost if we disappear mid-request.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, saving]);

  const dirty = subject !== (data.draftSubject ?? "") ||
    body !== (data.draftHtml ? htmlToPlain(data.draftHtml) : "");

  const save = useCallback(async () => {
    setSaving(true);
    setSaveNote(null);
    try {
      const r = await fetch(`/api/pipeline/${data.leadId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draftSubject: subject, draftHtml: plainToHtml(body) }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setSaveNote(`Save failed: ${d.error ?? r.status}`);
        return;
      }
      setSaveNote("Saved.");
      setTimeout(() => setSaveNote(null), 2000);
    } catch (e) {
      setSaveNote(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }, [data.leadId, subject, body]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(17, 24, 39, 0.85)",
        zIndex: 80,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header bar */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "12px 20px",
        background: "var(--card, #fff)",
        borderBottom: "1px solid var(--border, #e5e7eb)",
        flexShrink: 0,
      }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 11.5, color: "var(--text-tertiary, #9ca3af)", marginBottom: 2 }}>
            {data.authorName || data.authorEmail} · status: {data.status}
          </div>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text, #111827)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {data.title}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          {saveNote && (
            <span style={{ fontSize: 12, color: saveNote.startsWith("Save failed") ? "#dc2626" : "#16a34a" }}>
              {saveNote}
            </span>
          )}
          <button
            onClick={save}
            disabled={!dirty || saving}
            className="btn btn-primary"
            style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13 }}
          >
            {saving ? <Loader2 style={{ width: 14, height: 14 }} className="spin" /> : <Save style={{ width: 14, height: 14 }} />}
            Save
          </button>
          <button
            onClick={onClose}
            title="Close (Esc)"
            style={{ background: "transparent", border: 0, color: "var(--text-tertiary, #9ca3af)", cursor: "pointer", padding: 4, lineHeight: 0 }}
          >
            <X style={{ width: 20, height: 20 }} />
          </button>
        </div>
      </div>

      {/* Split body */}
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* Left: paper */}
        <div style={{ flex: 1, minWidth: 0, background: "#1f2937", display: "flex", flexDirection: "column" }}>
          {data.pdfUrl ? (
            <iframe
              src={data.pdfUrl}
              title="paper PDF"
              style={{ flex: 1, border: 0, background: "white" }}
            />
          ) : (
            <div style={{ flex: 1, overflow: "auto", padding: 24, color: "#e5e7eb", fontSize: 13, lineHeight: 1.7 }}>
              <div style={{ fontSize: 11.5, color: "#9ca3af", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
                No PDF attached
              </div>
              {data.abstract ? (
                <p style={{ whiteSpace: "pre-wrap" }}>{data.abstract}</p>
              ) : (
                <p style={{ color: "#9ca3af", fontStyle: "italic" }}>No abstract either.</p>
              )}
            </div>
          )}
          {data.pdfUrl && (
            <div style={{ padding: "6px 12px", background: "#111827", borderTop: "1px solid #374151", color: "#9ca3af", fontSize: 11.5, display: "flex", alignItems: "center", gap: 6 }}>
              <a href={data.pdfUrl} target="_blank" rel="noopener noreferrer" style={{ color: "#93c5fd", display: "inline-flex", alignItems: "center", gap: 4 }}>
                Open PDF in new tab <ExternalLink style={{ width: 11, height: 11 }} />
              </a>
            </div>
          )}
        </div>

        {/* Right: draft editor */}
        <div style={{ width: "50%", minWidth: 420, borderLeft: "1px solid var(--border, #e5e7eb)", background: "var(--card, #fff)", display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border-light, #f3f4f6)", flexShrink: 0 }}>
            <label style={{ fontSize: 11, color: "var(--text-tertiary, #9ca3af)", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>
              Subject
            </label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              style={{
                width: "100%",
                marginTop: 4,
                padding: "8px 10px",
                fontSize: 14,
                border: "1px solid var(--border, #e5e7eb)",
                borderRadius: 6,
                background: "var(--bg, #f9fafb)",
                color: "var(--text, #111827)",
              }}
            />
          </div>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "14px 18px", minHeight: 0 }}>
            <label style={{ fontSize: 11, color: "var(--text-tertiary, #9ca3af)", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600, marginBottom: 4 }}>
              Body (plain text)
            </label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              style={{
                flex: 1,
                padding: "10px 12px",
                fontSize: 14,
                lineHeight: 1.7,
                border: "1px solid var(--border, #e5e7eb)",
                borderRadius: 6,
                background: "var(--bg, #f9fafb)",
                color: "var(--text, #111827)",
                resize: "none",
                fontFamily: "var(--font-body, system-ui)",
                outline: "none",
              }}
            />
            <div style={{ marginTop: 8, fontSize: 11, color: "var(--text-tertiary, #9ca3af)" }}>
              Save writes back to the draft. Sending still happens from Review mode (age-gate + quota).
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
