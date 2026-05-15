"use client";

/**
 * /admin/inbox
 *
 * Admin-only dashboard surfacing the admin_inbox table (migration 058).
 * Each row is something Leon (the helper bot) recorded as worth admin's
 * attention — "this rep is stuck on onboarding", "this trend looks
 * weird", "consider this idea". Distinct from get_admin_alerts (which
 * is derived from running queries on demand) and lark_messages (raw
 * chat history).
 *
 * Row lifecycle: new → acknowledged → done | dismissed.
 *   - new:          unread; default filter shows these
 *   - acknowledged: admin has seen it, will deal with later
 *   - done:         resolved
 *   - dismissed:    not actionable / Leon was wrong
 *
 * The page does NOT mutate admin_inbox directly — it always goes
 * through POST /api/admin/inbox so the role recheck and the CHECK
 * constraint validation happen server-side.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Inbox, AlertCircle, Check, X, Loader2, RefreshCw } from "lucide-react";

interface InboxRow {
  id: string;
  kind: "request" | "observation" | "idea";
  headline: string;
  body: string | null;
  source_rep_id: number | null;
  evidence: Record<string, unknown> | null;
  status: "new" | "acknowledged" | "dismissed" | "done" | "awaiting_reason";
  rejected_reason?: string | null;
  dedup_hash: string;
  created_at: string;
  updated_at: string;
  acted_at: string | null;
}

type StatusFilter = "new" | "all";

const KIND_LABEL: Record<InboxRow["kind"], string> = {
  request: "Request",
  observation: "Observation",
  idea: "Idea",
};

// Visual style per kind. Requests are highest-attention (something to
// DO), observations are FYI, ideas are "consider this".
const KIND_STYLE: Record<InboxRow["kind"], string> = {
  request: "bg-red-50 text-red-700 border-red-200",
  observation: "bg-blue-50 text-blue-700 border-blue-200",
  idea: "bg-amber-50 text-amber-700 border-amber-200",
};

const STATUS_LABEL: Record<InboxRow["status"], string> = {
  new: "New",
  acknowledged: "Acknowledged",
  dismissed: "Dismissed",
  done: "Done",
  awaiting_reason: "Awaiting reason",
};

// Provenance — where did this idea come from? Same taxonomy as the
// Lark card (see src/lib/admin-inbox-card.ts:inferCardSource).
const SOURCE_LABEL: Record<string, string> = {
  leon_uncertain: "🤔 Leon 不确定 (escalation)",
  leon_observation: "👀 Leon 自己注意到的",
  curriculum_miner: "📊 跨 rep 模式",
  dynamic_tool_proposal: "🧰 Leon 想造工具",
  congress: "🏛 议事厅",
  rep_request: "🙋 Rep 直接 request",
  admin_self: "✍️ Admin 自己记的",
};

function sourceForRow(evidence: Record<string, unknown> | null): { source: string; label: string } {
  const e = evidence ?? {};
  if (typeof e.source === "string" && SOURCE_LABEL[e.source]) {
    return { source: e.source, label: SOURCE_LABEL[e.source] };
  }
  if (typeof e.escalation_source === "string" || typeof e.my_best_guess === "string" || typeof e.why_unsure === "string") {
    return { source: "leon_uncertain", label: SOURCE_LABEL.leon_uncertain };
  }
  if (typeof e.dynamic_tool_id === "string") {
    return { source: "dynamic_tool_proposal", label: SOURCE_LABEL.dynamic_tool_proposal };
  }
  if (typeof e.medoid === "string" || e.source === "curriculum_miner") {
    return { source: "curriculum_miner", label: SOURCE_LABEL.curriculum_miner };
  }
  return { source: "leon_observation", label: SOURCE_LABEL.leon_observation };
}

export default function AdminInboxPage() {
  const router = useRouter();
  const [rows, setRows] = useState<InboxRow[]>([]);
  const [repNames, setRepNames] = useState<Record<number, string>>({});
  const [filter, setFilter] = useState<StatusFilter>("new");
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null); // row id mid-update
  const [authError, setAuthError] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/inbox?status=${filter}`, {
        credentials: "include",
      });
      if (res.status === 403) {
        setAuthError(true);
        return;
      }
      if (!res.ok) {
        // We don't swallow non-403 errors — surface them so admin can act.
        const err = await res.json().catch(() => ({}));
        console.error("[admin/inbox] load failed:", res.status, err);
        setRows([]);
        return;
      }
      const data = (await res.json()) as { rows: InboxRow[]; rep_names: Record<number, string> };
      setRows(data.rows);
      setRepNames(data.rep_names);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { void load(); }, [load]);

  // Click handler for the Yes/No/Skill/Memory/Both/Neither buttons.
  // Routes through the new POST { action } path so /admin/inbox produces
  // the same helper_learnings rows as the Lark card.
  const handleAction = useCallback(
    async (row: InboxRow, action: "yes" | "no" | "skill" | "memory" | "both" | "neither") => {
      setActing(row.id);
      try {
        const res = await fetch("/api/admin/inbox", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: row.id, action }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          alert(`Action failed: ${err.error ?? res.status}`);
          return;
        }
        // Any action terminates the row's lifecycle (status → acknowledged/dismissed/done).
        // If we're filtered to "new", drop it from view; otherwise refresh.
        if (filter === "new") {
          setRows((prev) => prev.filter((r) => r.id !== row.id));
        } else {
          void load();
        }
      } finally {
        setActing(null);
      }
    },
    [filter, load],
  );

  const newCount = useMemo(() => rows.filter((r) => r.status === "new").length, [rows]);

  // Bulk-dismiss currently-selected ids.
  const bulkDismissSelected = useCallback(async () => {
    if (selected.size === 0) return;
    setBulkBusy(true);
    try {
      const ids = Array.from(selected);
      const res = await fetch("/api/admin/inbox/bulk-dismiss", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (res.ok) {
        setRows((prev) => filter === "new" ? prev.filter((r) => !selected.has(r.id)) : prev);
        setSelected(new Set());
      }
    } finally {
      setBulkBusy(false);
    }
  }, [selected, filter]);

  // Dismiss everything matching a filter (server picks the ids).
  const bulkDismissFilter = useCallback(async (filterDef: { older_than_days?: number; headline_starts_with?: string; source?: string }) => {
    setBulkBusy(true);
    try {
      const res = await fetch("/api/admin/inbox/bulk-dismiss", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filter: filterDef }),
      });
      if (res.ok) await load();
    } finally {
      setBulkBusy(false);
    }
  }, [load]);

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const selectAllVisible = useCallback(() => {
    setSelected(new Set(rows.filter((r) => r.status === "new").map((r) => r.id)));
  }, [rows]);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  if (authError) {
    return (
      <div className="max-w-2xl mx-auto p-8">
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
          <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-3" />
          <h1 className="text-xl font-semibold text-red-900 mb-2">Admin only</h1>
          <p className="text-red-700 text-sm mb-4">
            This page is restricted to reps with role = admin.
          </p>
          <button
            onClick={() => router.push("/")}
            className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 text-sm"
          >
            Back to dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Inbox className="w-7 h-7 text-slate-700" />
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">Admin inbox</h1>
            <p className="text-sm text-slate-500">
              What Leon thinks you should see — requests, observations, ideas.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-md border border-slate-200 overflow-hidden">
            <button
              className={`px-3 py-1.5 text-sm ${
                filter === "new"
                  ? "bg-slate-900 text-white"
                  : "bg-white text-slate-700 hover:bg-slate-50"
              }`}
              onClick={() => setFilter("new")}
            >
              New {filter === "new" && newCount > 0 && `(${newCount})`}
            </button>
            <button
              className={`px-3 py-1.5 text-sm border-l border-slate-200 ${
                filter === "all"
                  ? "bg-slate-900 text-white"
                  : "bg-white text-slate-700 hover:bg-slate-50"
              }`}
              onClick={() => setFilter("all")}
            >
              All
            </button>
          </div>
          <button
            onClick={() => void load()}
            className="p-1.5 rounded-md hover:bg-slate-100 text-slate-600"
            title="Refresh"
            disabled={loading}
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Bulk action bar — appears when there's any pending or there are
          obvious-to-clean batches. Two flavors:
          (a) selection mode: when N rows selected, "Dismiss N selected"
          (b) quick-clean: always-available shortcuts for obvious junk
              (SMOKE rows, hypothesis-test batch, >14d stale). */}
      {filter === "new" && newCount > 0 && (
        <div className="mb-4 px-3 py-2 bg-slate-50 border border-slate-200 rounded-md flex items-center gap-2 flex-wrap text-xs">
          {selected.size > 0 ? (
            <>
              <span className="text-slate-700 font-medium">{selected.size} selected</span>
              <button
                onClick={() => void bulkDismissSelected()}
                disabled={bulkBusy}
                className="px-2.5 py-1 bg-red-50 text-red-700 border border-red-200 rounded hover:bg-red-100 disabled:opacity-50"
              >
                Dismiss {selected.size}
              </button>
              <button onClick={clearSelection} className="text-slate-500 hover:text-slate-700 px-2">
                Clear
              </button>
            </>
          ) : (
            <>
              <span className="text-slate-500">Quick clean:</span>
              <button
                onClick={() => void bulkDismissFilter({ headline_starts_with: "🧪 Hypothesis" })}
                disabled={bulkBusy}
                className="px-2 py-1 bg-white border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-50"
              >
                Hypothesis tests
              </button>
              <button
                onClick={() => void bulkDismissFilter({ headline_starts_with: "SMOKE" })}
                disabled={bulkBusy}
                className="px-2 py-1 bg-white border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-50"
              >
                SMOKE rows
              </button>
              <button
                onClick={() => void bulkDismissFilter({ older_than_days: 14 })}
                disabled={bulkBusy}
                className="px-2 py-1 bg-white border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-50"
              >
                Older than 14d
              </button>
              <span className="text-slate-300">·</span>
              <button onClick={selectAllVisible} className="text-slate-500 hover:text-slate-700 px-1">
                Select all visible
              </button>
            </>
          )}
        </div>
      )}

      {!loading && rows.length === 0 && (
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-10 text-center">
          <Inbox className="w-10 h-10 text-slate-400 mx-auto mb-3" />
          <p className="text-slate-600 font-medium">
            {filter === "new" ? "Inbox zero 🎉" : "No entries yet"}
          </p>
          <p className="text-slate-500 text-sm mt-1">
            {filter === "new"
              ? "Leon hasn't flagged anything new for you."
              : "Leon hasn't recorded any inbox entries yet — try /all once there's activity."}
          </p>
        </div>
      )}

      <div className="space-y-3">
        {rows.map((row) => (
          <div
            key={row.id}
            className={`bg-white border rounded-lg p-4 transition ${
              row.status === "new" ? "border-slate-300 shadow-sm" : "border-slate-200 opacity-75"
            }`}
          >
            <div className="flex items-start justify-between gap-4">
              {row.status === "new" && (
                <input
                  type="checkbox"
                  checked={selected.has(row.id)}
                  onChange={() => toggleSelect(row.id)}
                  className="mt-1.5 w-4 h-4 shrink-0 cursor-pointer accent-slate-700"
                  title="Select for bulk action"
                />
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1.5">
                  <span
                    className={`text-[11px] font-medium px-2 py-0.5 rounded border ${KIND_STYLE[row.kind]}`}
                  >
                    {KIND_LABEL[row.kind]}
                  </span>
                  <span className="text-[11px] font-medium px-2 py-0.5 rounded bg-slate-50 border border-slate-200 text-slate-700">
                    {sourceForRow(row.evidence).label}
                  </span>
                  {row.status !== "new" && (
                    <span className="text-[11px] font-medium px-2 py-0.5 rounded bg-slate-100 text-slate-600">
                      {STATUS_LABEL[row.status]}
                    </span>
                  )}
                  {row.source_rep_id != null && repNames[row.source_rep_id] && (
                    <span className="text-[11px] text-slate-500">
                      from {repNames[row.source_rep_id]}
                    </span>
                  )}
                  <span className="text-[11px] text-slate-400 ml-auto">
                    {new Date(row.created_at).toLocaleString()}
                  </span>
                </div>
                <p className="text-slate-900 font-medium leading-snug">{row.headline}</p>
                {row.body && (
                  <p className="text-slate-600 text-sm mt-1.5 whitespace-pre-wrap">{row.body}</p>
                )}
                {row.rejected_reason && (
                  <div className="mt-2 px-2.5 py-1.5 bg-red-50 border-l-2 border-red-300 rounded-r">
                    <p className="text-[11px] font-medium text-red-700 mb-0.5">Why you said No</p>
                    <p className="text-sm text-red-900 whitespace-pre-wrap">{row.rejected_reason}</p>
                  </div>
                )}
                {row.status === "awaiting_reason" && (
                  <p className="text-[11px] text-amber-700 mt-1.5">⏳ Waiting for you to DM the reason in Lark…</p>
                )}
                {row.evidence && Object.keys(row.evidence).length > 0 && (
                  <details className="mt-2">
                    <summary className="text-xs text-slate-500 cursor-pointer hover:text-slate-700">
                      Evidence
                    </summary>
                    <pre className="mt-1.5 text-[11px] bg-slate-50 border border-slate-200 rounded p-2 overflow-x-auto">
                      {JSON.stringify(row.evidence, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
              <div className="flex flex-col gap-1.5 shrink-0 min-w-[140px]">
                <button
                  onClick={() => void handleAction(row, "yes")}
                  disabled={acting === row.id || row.status !== "new"}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded border border-emerald-300 text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
                  title={
                    row.kind === "request"
                      ? "Approve / acknowledge this request"
                      : "Yes — Leon auto-classifies as skill or memory"
                  }
                >
                  <Check className="w-3 h-3" /> Yes
                </button>
                <button
                  onClick={() => void handleAction(row, "no")}
                  disabled={acting === row.id || row.status !== "new"}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded border border-red-300 text-red-600 hover:bg-red-50 disabled:opacity-50"
                  title="No — Leon will DM you in Lark asking why"
                >
                  <X className="w-3 h-3" /> No
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
