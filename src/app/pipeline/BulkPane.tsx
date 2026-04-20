"use client";

/**
 * Bulk-mode list view.
 *
 * One row per ready lead with a checkbox per row. Rows where age >= 7d are
 * preselected; rows where age < 7d are unchecked by default and offer an
 * inline override toggle. "Send all selected" POSTs to /api/pipeline/batch-send
 * with `{ids: [...], overrides: [...]}` after a confirm dialog.
 */

import { useEffect, useMemo, useState } from "react";
import { Loader2, Send } from "lucide-react";
import { Lead } from "./types";
import { isAgeGated, leadAgeDays, MIN_AGE_DAYS } from "@/lib/policy";

interface Props {
  leads: Lead[];
  onDone: (sent: number, skipped: number) => void;
  onError: (msg: string) => void;
}

function ageLabel(createdAt: string): string {
  const days = leadAgeDays(createdAt);
  if (days < 1) return `${Math.max(0, Math.floor(days * 24))}h old`;
  return `${Math.floor(days)}d old`;
}

function snippetFor(lead: Lead): string {
  const subj = lead.draftSubject || "(no subject)";
  return subj.length > 80 ? subj.slice(0, 80) + "…" : subj;
}

export function BulkPane({ leads, onDone, onError }: Props) {
  const ready = useMemo(
    () => leads.filter((l) => l.status === "ready" && l.draftHtml && l.authorEmail),
    [leads],
  );

  // selected: ids the user has checked. By default we preselect rows where
  // age >= 7d; gated rows are off until the operator overrides.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [overrides, setOverrides] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const next = new Set<string>();
    for (const l of ready) {
      if (!isAgeGated(l.createdAt)) next.add(l.id);
    }
    setSelected(next);
    setOverrides(new Set());
  }, [ready]);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleOverride = (id: string) => {
    setOverrides((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        // Also remove from selection — can't send a gated row without override
        setSelected((s) => {
          const ns = new Set(s);
          ns.delete(id);
          return ns;
        });
      } else {
        next.add(id);
        setSelected((s) => {
          const ns = new Set(s);
          ns.add(id);
          return ns;
        });
      }
      return next;
    });
  };

  const ids = useMemo(() => Array.from(selected), [selected]);
  const overrideList = useMemo(
    () => ids.filter((id) => overrides.has(id)),
    [ids, overrides],
  );

  const handleSend = async () => {
    if (ids.length === 0) return;
    const ok = window.confirm(`About to send ${ids.length} email${ids.length === 1 ? "" : "s"}. Continue?`);
    if (!ok) return;
    setSending(true);
    try {
      const res = await fetch("/api/pipeline/batch-send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, overrides: overrideList }),
      });
      const data = await res.json();
      if (!res.ok) {
        onError(data.error || "Batch send failed");
        return;
      }
      onDone(data.sent || 0, data.skipped || 0);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Network error");
    } finally {
      setSending(false);
    }
  };

  if (ready.length === 0) {
    return (
      <div className="dx-empty" style={{ marginTop: 12 }}>
        <div className="dx-empty-glyph">0</div>
        <div className="dx-empty-body">
          <div className="dx-empty-title">No ready leads</div>
          <div className="dx-empty-text">
            No leads in the current filter are ready to send. Adjust filters or run a scan.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="dx-review-bar">
        <span className="dx-review-pos">{ids.length} selected</span>
        <span className="dx-review-sub">
          of {ready.length} ready · {ready.filter((l) => isAgeGated(l.createdAt)).length} need
          override
        </span>
        <div className="dx-review-spacer" />
        <button
          type="button"
          className="dx-secondary"
          onClick={() => setSelected(new Set(ready.filter((l) => !isAgeGated(l.createdAt)).map((l) => l.id)))}
          disabled={sending}
        >
          Reset selection
        </button>
        <button
          type="button"
          className="dx-primary"
          onClick={handleSend}
          disabled={sending || ids.length === 0}
        >
          {sending ? <Loader2 className="animate-spin" /> : <Send />}
          Send all selected ({ids.length})
        </button>
      </div>

      <div className="dx-bulk-list">
        {ready.map((lead) => {
          const gated = isAgeGated(lead.createdAt);
          const checked = selected.has(lead.id);
          const overridden = overrides.has(lead.id);
          return (
            <div
              key={lead.id}
              className={`dx-bulk-row${gated && !overridden ? " gated" : ""}`}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={gated && !overridden}
                onChange={() => toggleSelect(lead.id)}
                aria-label={`Select ${lead.authorName || lead.id}`}
              />
              <span className={`dx-bulk-tier ${lead.leadTier === "strong" ? "strong" : ""}`}>
                {lead.leadTier === "strong" ? "Strong" : "Normal"}
              </span>
              <div style={{ minWidth: 0 }}>
                <div className="dx-bulk-author">{lead.authorName || lead.authorEmail}</div>
                <div className="dx-bulk-snippet">{snippetFor(lead)}</div>
              </div>
              <span className={`dx-bulk-age${gated ? " gated" : ""}`}>
                {ageLabel(lead.createdAt)}
                {gated ? ` — needs override` : ""}
              </span>
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                {gated && (
                  <label className="dx-override-toggle">
                    <input
                      type="checkbox"
                      checked={overridden}
                      onChange={() => toggleOverride(lead.id)}
                    />
                    Override {MIN_AGE_DAYS}d
                  </label>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
