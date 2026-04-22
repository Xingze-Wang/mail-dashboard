"use client";

/**
 * Bulk-mode list view.
 *
 * One row per ready lead with a checkbox per row. Rows where age >= 7d are
 * preselected; rows where age < 7d are unchecked by default and offer an
 * inline override toggle. "Send all selected" POSTs to /api/pipeline/batch-send
 * with `{ids: [...], overrides: [...]}` after a confirm dialog.
 */

import { useEffect, useMemo, useRef, useState } from "react";
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
  // Progress for large batches — server caps each POST at 200, so anything
  // bigger auto-chunks. Null when not in-flight.
  const [progress, setProgress] = useState<{ done: number; total: number; sent: number; skipped: number } | null>(null);

  // Preselect non-gated rows ONCE on mount. Previously this effect fired
  // on every `ready` reference change — and every fetchLeads() produces a
  // new reference — which silently wiped the user's per-row checkboxes
  // whenever a background refresh happened. Now we initialize once and
  // let `toggleSelect` own the state from there. New leads that arrive
  // later stay unselected until the user explicitly ticks them, which is
  // the correct default for bulk workflows.
  const didInitRef = useRef(false);
  useEffect(() => {
    if (didInitRef.current) return;
    if (ready.length === 0) return;
    const next = new Set<string>();
    for (const l of ready) {
      if (!isAgeGated(l.createdAt)) next.add(l.id);
    }
    setSelected(next);
    didInitRef.current = true;
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

  // Chunked send: the server caps each POST at 200 (Vercel function
  // timeout constraint). When the user picks more than that we auto-split
  // into sequential batches so "Select all" works on a 167-lead queue
  // without the user having to manually tick 50 at a time. Batches run
  // serially to respect per-rep override quota and avoid Resend rate
  // spikes; a single failing batch doesn't kill later ones.
  const CHUNK_SIZE = 200;

  const handleSend = async () => {
    if (ids.length === 0) return;
    const ok = window.confirm(`About to send ${ids.length} email${ids.length === 1 ? "" : "s"}. Continue?`);
    if (!ok) return;
    setSending(true);
    setProgress({ done: 0, total: ids.length, sent: 0, skipped: 0 });

    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      chunks.push(ids.slice(i, i + CHUNK_SIZE));
    }
    const overrideSet = new Set(overrideList);

    let totalSent = 0;
    let totalSkipped = 0;
    const allBlocks: Record<string, number> = {};
    const allErrors: string[] = [];

    try {
      for (let i = 0; i < chunks.length; i++) {
        const chunkIds = chunks[i];
        const chunkOverrides = chunkIds.filter((id) => overrideSet.has(id));
        try {
          const res = await fetch("/api/pipeline/batch-send", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids: chunkIds, overrides: chunkOverrides }),
          });
          const data = await res.json();
          if (!res.ok) {
            // Record the batch-level failure but keep going — losing one
            // chunk of 200 shouldn't abort the remaining 500.
            allErrors.push(`Batch ${i + 1}: ${data.error ?? "failed"}`);
            totalSkipped += chunkIds.length;
          } else {
            totalSent += data.sent || 0;
            totalSkipped += data.skipped || 0;
            if (data.blocks && typeof data.blocks === "object") {
              for (const [code, n] of Object.entries(data.blocks as Record<string, number>)) {
                allBlocks[code] = (allBlocks[code] ?? 0) + n;
              }
            }
            if (Array.isArray(data.errors)) {
              for (const e of data.errors) allErrors.push(String(e));
            }
          }
        } catch (e) {
          allErrors.push(`Batch ${i + 1}: ${e instanceof Error ? e.message : String(e)}`);
          totalSkipped += chunkIds.length;
        }
        setProgress({
          done: Math.min((i + 1) * CHUNK_SIZE, ids.length),
          total: ids.length,
          sent: totalSent,
          skipped: totalSkipped,
        });
      }

      // Single toast summarizes the whole multi-batch send, so the user
      // doesn't see 4 toasts stack for a 4-batch send.
      if (totalSkipped > 0) {
        const parts = Object.entries(allBlocks)
          .map(([code, n]) => `${code}: ${n}`)
          .join(", ");
        if (parts) {
          onError(`Sent ${totalSent}, skipped ${totalSkipped} — ${parts}`);
        } else if (allErrors.length > 0) {
          onError(`Sent ${totalSent}, skipped ${totalSkipped} — ${allErrors[0]}`);
        }
      }
      onDone(totalSent, totalSkipped);
    } finally {
      setSending(false);
      setProgress(null);
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

  const gatedCount = ready.filter((l) => isAgeGated(l.createdAt)).length;
  const allSelected = ids.length === ready.length && ready.length > 0;
  const noneSelected = ids.length === 0;

  // "Select all" toggles between three states:
  //   none   → select all NON-gated
  //   some   → select all (override the gated ones too)
  //   all    → clear
  const handleSelectAll = () => {
    if (allSelected) {
      setSelected(new Set());
      setOverrides(new Set());
      return;
    }
    if (noneSelected) {
      const nonGated = ready.filter((l) => !isAgeGated(l.createdAt)).map((l) => l.id);
      if (nonGated.length > 0) {
        setSelected(new Set(nonGated));
        return;
      }
    }
    // Mixed or every row is gated → select everything and auto-override
    setSelected(new Set(ready.map((l) => l.id)));
    setOverrides(new Set(ready.filter((l) => isAgeGated(l.createdAt)).map((l) => l.id)));
  };

  return (
    <div>
      <div className="dx-review-bar">
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--dx-text-2)" }}>
          <input
            type="checkbox"
            checked={allSelected}
            ref={(el) => { if (el) el.indeterminate = !allSelected && !noneSelected; }}
            onChange={handleSelectAll}
            disabled={sending || ready.length === 0}
            aria-label="Select all"
          />
          Select all
        </label>
        <span className="dx-review-pos" style={{ marginLeft: 8 }}>{ids.length} selected</span>
        <span className="dx-review-sub">
          of {ready.length} ready{gatedCount > 0 ? ` · ${gatedCount} need override` : ""}
        </span>
        <div className="dx-review-spacer" />
        <button
          type="button"
          className="dx-primary"
          onClick={handleSend}
          disabled={sending || ids.length === 0}
        >
          {sending ? <Loader2 className="animate-spin" /> : <Send />}
          {progress
            ? `Sending ${progress.done}/${progress.total}…`
            : `Send ${ids.length > 0 ? `${ids.length} ` : ""}${ids.length === 1 ? "email" : "emails"}`}
        </button>
      </div>

      {/* Per-batch progress bar — only renders while a multi-chunk send
          is in flight. Counters update after each chunk completes. */}
      {progress && (
        <div style={{ margin: "12px 0", padding: "8px 12px", background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
            <span>
              Sending… {progress.done} / {progress.total}
            </span>
            <span style={{ color: "var(--muted)" }}>
              sent {progress.sent} · skipped {progress.skipped}
            </span>
          </div>
          <div style={{ height: 4, background: "var(--border)", borderRadius: 2, overflow: "hidden" }}>
            <div
              style={{
                width: `${(progress.done / progress.total) * 100}%`,
                height: "100%",
                background: "#111",
                transition: "width 200ms",
              }}
            />
          </div>
        </div>
      )}

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
