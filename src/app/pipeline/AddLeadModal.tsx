"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, X } from "lucide-react";

interface AddLeadModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

const EMPTY = {
  authorEmail: "",
  authorName: "",
  title: "",
  arxivId: "",
  pdfUrl: "",
  schoolName: "",
  abstract: "",
};

/**
 * Manual lead entry modal. Posts to /api/pipeline/import which dedupes
 * via the contact-guard and inserts into pipeline_leads.
 *
 * Required: authorEmail. The arxivId / pdfUrl pair is optional — if neither
 * is given, the import endpoint synthesises a unique id from `source` + ts.
 *
 * The lead is inserted with status "new" (no draft is generated client-side).
 * The user can re-trigger enrichment by clicking "Scan arXiv" in the header.
 */
export function AddLeadModal({ open, onClose, onCreated }: AddLeadModalProps) {
  const [form, setForm] = useState(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setForm(EMPTY);
      setError(null);
    }
  }, [open]);

  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return;
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, handleKey]);

  if (!open) return null;

  const canSubmit =
    form.authorEmail.trim().length > 0 &&
    (form.arxivId.trim().length > 0 || form.pdfUrl.trim().length > 0);

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch("/api/pipeline/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          authorEmail: form.authorEmail.trim(),
          authorName: form.authorName.trim() || null,
          title: form.title.trim() || "(manual lead)",
          arxivId: form.arxivId.trim() || undefined,
          pdfUrl: form.pdfUrl.trim() || null,
          schoolName: form.schoolName.trim() || null,
          abstract: form.abstract.trim() || null,
          source: "manual",
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to add lead");
        return;
      }
      if (data.imported === 0) {
        const blocked = (data.blockedByGuard ?? [])[0];
        if (blocked) {
          setError(
            `Already contacted ${blocked.email} on ${new Date(blocked.lastContactedAt).toLocaleDateString()}`,
          );
        } else {
          setError(data.errors?.[0] || "Lead skipped (likely duplicate)");
        }
        return;
      }

      onCreated();
      onClose();
    } catch {
      setError("Network error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card"
        style={{ width: "100%", maxWidth: 560 }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 20px",
            borderBottom: "1px solid var(--border-light)",
          }}
        >
          <h2
            style={{
              fontFamily: "var(--font-heading)",
              fontSize: 16,
              fontWeight: 600,
              color: "var(--text)",
              letterSpacing: "-0.01em",
            }}
          >
            Add Lead
          </h2>
          <button onClick={onClose} className="btn-ghost" aria-label="Close" style={{ borderRadius: 6 }}>
            <X style={{ width: 14, height: 14 }} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14, overflowY: "auto" }}>
          <div className="form-section" style={{ marginBottom: 0 }}>
            <label>Author Email *</label>
            <input
              type="email"
              value={form.authorEmail}
              onChange={(e) => setForm({ ...form, authorEmail: e.target.value })}
              placeholder="founder@startup.com"
              autoFocus
            />
          </div>

          <div className="form-section" style={{ marginBottom: 0 }}>
            <label>Author Name</label>
            <input
              type="text"
              value={form.authorName}
              onChange={(e) => setForm({ ...form, authorName: e.target.value })}
              placeholder="John Doe"
            />
          </div>

          <div className="form-section" style={{ marginBottom: 0 }}>
            <label>Title</label>
            <input
              type="text"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="Paper title or company name"
            />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <div className="form-section" style={{ marginBottom: 0 }}>
              <label>arXiv ID</label>
              <input
                type="text"
                value={form.arxivId}
                onChange={(e) => setForm({ ...form, arxivId: e.target.value })}
                placeholder="2604.12345"
              />
            </div>
            <div className="form-section" style={{ marginBottom: 0 }}>
              <label>PDF URL</label>
              <input
                type="url"
                value={form.pdfUrl}
                onChange={(e) => setForm({ ...form, pdfUrl: e.target.value })}
                placeholder="https://arxiv.org/pdf/..."
              />
            </div>
          </div>

          <div className="form-section" style={{ marginBottom: 0 }}>
            <label>School / Affiliation</label>
            <input
              type="text"
              value={form.schoolName}
              onChange={(e) => setForm({ ...form, schoolName: e.target.value })}
              placeholder="MIT"
            />
          </div>

          <div className="form-section" style={{ marginBottom: 0 }}>
            <label>Notes / Abstract</label>
            <textarea
              value={form.abstract}
              onChange={(e) => setForm({ ...form, abstract: e.target.value })}
              placeholder="Why this lead matters…"
              rows={4}
              style={{ resize: "none", lineHeight: 1.6 }}
            />
          </div>

          <p
            className="helper"
            style={{
              fontSize: 11.5,
              color: "var(--text-tertiary)",
              lineHeight: 1.5,
              marginTop: -2,
            }}
          >
            Either an arXiv ID or PDF URL is required so we can dedupe. The lead will land
            in <strong style={{ color: "var(--text)" }}>New</strong> — re-run “Scan arXiv”
            to enrich and draft.
          </p>

          {error && (
            <p
              style={{
                fontSize: 12,
                fontWeight: 500,
                color: "var(--coral)",
              }}
            >
              {error}
            </p>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 10,
            padding: "14px 20px",
            borderTop: "1px solid var(--border-light)",
          }}
        >
          <button onClick={onClose} className="btn">Cancel</button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit || submitting}
            className="btn btn-primary"
          >
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus />}
            {submitting ? "Adding…" : "Add Lead"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default AddLeadModal;
