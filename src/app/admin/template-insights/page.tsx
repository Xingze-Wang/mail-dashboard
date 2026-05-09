"use client";

/**
 * /admin/template-insights
 *
 * Surfaces per-template AI vs human ratings to find disagreement
 * gaps. The user's framing: insights need a WHY, not just numbers.
 * So this page emphasizes:
 *   1. The mean_gap (|AI − human|) sorted DESC — biggest disagreements
 *      first, those are the hypothesis-generating signals
 *   2. Sample reasonings from both sides — the gap means nothing
 *      without seeing what each rater said
 *   3. A "Backfill ratings" button that calls /api/admin/rate-recent
 *      so admin can populate AI ratings on emails that were sent
 *      before this feature shipped
 *
 * The page is intentionally minimal — meant for the admin to read,
 * notice patterns, then write hypotheses (template improvements,
 * segment splits) into admin_inbox manually or via Leon. The
 * automation that turns insights into proposals lives in the cron
 * /api/cron/template-proposals.
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, AlertCircle, RefreshCw, Sparkles, Brain, Users } from "lucide-react";

interface InsightRow {
  template_id: string;
  template_name: string | null;
  template_status: string | null;
  template_segment: string | null;
  n_human: number;
  mean_human: number | null;
  n_ai: number;
  mean_ai: number | null;
  n_both: number;
  mean_gap: number | null;
  sample_human_reason: string | null;
  sample_ai_reason: string | null;
}

export default function TemplateInsightsPage() {
  const [rows, setRows] = useState<InsightRow[]>([]);
  const [windowDays, setWindowDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillResult, setBackfillResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/templates/insights?days=${windowDays}`, {
        credentials: "include",
      });
      if (res.status === 403) { setAuthError(true); return; }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`Insights load failed: ${err.error ?? res.status}`);
        return;
      }
      const data = (await res.json()) as { rows: InsightRow[] };
      setRows(data.rows);
    } finally { setLoading(false); }
  }, [windowDays]);

  useEffect(() => { void load(); }, [load]);

  const backfill = useCallback(async () => {
    if (backfilling) return;
    setBackfilling(true);
    setBackfillResult(null);
    try {
      const res = await fetch("/api/admin/rate-recent", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 20, days: windowDays }),
      });
      const data = await res.json();
      if (!res.ok) {
        setBackfillResult(`Failed: ${data.error ?? res.status}`);
        return;
      }
      setBackfillResult(
        `Rated ${data.rated} emails (${data.errors} errors). Reload to see updated insights.`,
      );
      void load();
    } finally { setBackfilling(false); }
  }, [backfilling, windowDays, load]);

  if (authError) {
    return (
      <div className="max-w-2xl mx-auto p-8">
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
          <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-3" />
          <h1 className="text-xl font-semibold text-red-900 mb-2">Admin only</h1>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto p-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Template insights</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            AI vs human ratings per template. Sorted by |gap| DESC — biggest disagreements first.
            Read the sample reasonings to find hypotheses.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={windowDays}
            onChange={(e) => setWindowDays(Number(e.target.value))}
            className="text-sm border border-slate-300 rounded px-2 py-1.5"
          >
            <option value={7}>7 days</option>
            <option value={14}>14 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
          </select>
          <button
            onClick={() => void load()}
            disabled={loading}
            className="p-1.5 rounded-md hover:bg-slate-100 text-slate-600 disabled:opacity-50"
            title="Refresh"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          </button>
          <button
            onClick={() => void backfill()}
            disabled={backfilling}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-purple-600 text-white rounded text-sm hover:bg-purple-700 disabled:opacity-50"
            title="Run AI rating on the last 20 unrated emails in this window"
          >
            {backfilling ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            Backfill AI ratings
          </button>
        </div>
      </div>

      {backfillResult && (
        <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded text-sm text-blue-800">
          {backfillResult}
        </div>
      )}

      {loading && rows.length === 0 && (
        <div className="p-12 text-center">
          <Loader2 className="w-6 h-6 animate-spin text-slate-400 mx-auto" />
        </div>
      )}

      {!loading && rows.length === 0 && (
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-10 text-center">
          <Brain className="w-10 h-10 text-slate-400 mx-auto mb-3" />
          <p className="text-slate-600 font-medium">No ratings yet in this window</p>
          <p className="text-slate-500 text-sm mt-1">
            Click "Backfill AI ratings" above to populate AI scores on recent emails,
            then reps need to rate manually for the human side.
          </p>
        </div>
      )}

      <div className="space-y-3">
        {rows.map((r) => {
          const gapColor = r.mean_gap == null
            ? "text-slate-400"
            : r.mean_gap > 1.5
              ? "text-red-600"
              : r.mean_gap > 0.8
                ? "text-amber-600"
                : "text-emerald-600";
          return (
            <div key={r.template_id} className="bg-white border border-slate-200 rounded-lg p-4">
              <div className="flex items-start justify-between gap-4 mb-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-sm font-medium text-slate-900">
                      {r.template_name ?? r.template_id.slice(0, 8)}
                    </span>
                    {r.template_status && r.template_status !== "active" && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-200">
                        {r.template_status.toUpperCase()}
                      </span>
                    )}
                    {r.template_segment && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">
                        seg={r.template_segment}
                      </span>
                    )}
                  </div>
                </div>
                <div className={`text-right shrink-0 ${gapColor}`}>
                  <div className="text-2xl font-semibold leading-none">
                    {r.mean_gap == null ? "—" : `±${r.mean_gap.toFixed(2)}`}
                  </div>
                  <div className="text-[10px] uppercase tracking-wide mt-1">avg gap</div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4 mt-3">
                <div className="flex items-start gap-2">
                  <Users className="w-4 h-4 text-slate-500 mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-slate-500">
                      Human ({r.n_human})
                      {r.mean_human != null && (
                        <span className="ml-1 font-medium text-slate-900">{r.mean_human.toFixed(2)}/5</span>
                      )}
                    </div>
                    {r.sample_human_reason ? (
                      <p className="text-[12px] text-slate-700 mt-1 leading-snug whitespace-pre-wrap line-clamp-3">
                        "{r.sample_human_reason}"
                      </p>
                    ) : (
                      <p className="text-[11px] text-slate-400 mt-1 italic">No human ratings yet</p>
                    )}
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <Sparkles className="w-4 h-4 text-purple-500 mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-slate-500">
                      AI ({r.n_ai})
                      {r.mean_ai != null && (
                        <span className="ml-1 font-medium text-slate-900">{r.mean_ai.toFixed(2)}/5</span>
                      )}
                    </div>
                    {r.sample_ai_reason ? (
                      <p className="text-[12px] text-slate-700 mt-1 leading-snug whitespace-pre-wrap line-clamp-3">
                        "{r.sample_ai_reason}"
                      </p>
                    ) : (
                      <p className="text-[11px] text-slate-400 mt-1 italic">No AI ratings yet</p>
                    )}
                  </div>
                </div>
              </div>
              {r.n_both > 0 && (
                <div className="mt-3 pt-2 border-t border-slate-100 text-[11px] text-slate-500">
                  {r.n_both} email(s) rated by both. Click any to drill down (coming soon).
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
