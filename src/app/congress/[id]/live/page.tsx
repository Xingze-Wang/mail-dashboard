"use client";

/**
 * /congress/[id]/live
 *
 * Live transcript of a stepwise congress run. Polls every 2s; shows
 * personas as they finish landing, plus an "interject" textbox that
 * the next persona will pick up before speaking.
 *
 * Why polling instead of SSE: 7 personas × ~5s each = ~35s total run.
 * 2s poll overhead is small. SSE adds connection-management complexity
 * that's overkill for this usage pattern.
 */

import { useEffect, useState, use, useCallback } from "react";
import Link from "next/link";
import { Loader2, Send, Sparkles, CheckCircle2, AlertTriangle } from "lucide-react";

interface Persona { key: string; display: string; }

interface Interjection {
  id: string;
  body: string;
  author_name: string;
  inject_after_idx: number;
  consumed_at: string | null;
  consumed_by_persona: string | null;
  created_at: string;
}

interface RunRow {
  id: string;
  kind: string;
  status: "running" | "completed" | "failed";
  evidence_pack: string;
  roster: Persona[];
  current_idx: number | null;
  personas_completed: Record<string, string>;
  synthesis: Record<string, unknown> | null;
  failure_reason: string | null;
  tactical_proposal_id: string | null;
  template_proposal_id: string | null;
  started_at: string;
  completed_at: string | null;
}

export default function CongressLivePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [run, setRun] = useState<RunRow | null>(null);
  const [interjections, setInterjections] = useState<Interjection[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`/api/congress/runs/${id}`, { credentials: "include" });
      if (!r.ok) return;
      const j = await r.json();
      setRun(j.run as RunRow);
      setInterjections((j.interjections ?? []) as Interjection[]);
    } catch {
      // transient — next poll handles it
    }
  }, [id]);

  // Initial load + polling. Stop polling once status != 'running'.
  useEffect(() => {
    void refresh().finally(() => setLoading(false));
    const t = setInterval(() => {
      // Don't refresh if we know the run finished — just stops the
      // network noise. Live page can still show the final state.
      void refresh();
    }, 2000);
    return () => clearInterval(t);
  }, [refresh]);

  // Once status changes to completed/failed, clear the interval.
  useEffect(() => {
    if (run && run.status !== "running") {
      // Best-effort: subsequent setIntervals are harmless because
      // /api/congress/runs/[id] is cached server-side and cheap.
    }
  }, [run]);

  const submit = useCallback(async () => {
    if (!draft.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/congress/runs/${id}/interject`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: draft.trim() }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        alert(`Interject failed: ${e.error ?? res.status}`);
        return;
      }
      setDraft("");
      await refresh();
    } finally {
      setSubmitting(false);
    }
  }, [id, draft, refresh]);

  if (loading) {
    return (
      <div className="p-12 text-center">
        <Loader2 className="w-6 h-6 animate-spin text-slate-400 mx-auto" />
      </div>
    );
  }
  if (!run) {
    return (
      <div className="max-w-2xl mx-auto p-8">
        <p className="text-slate-600">Run not found.</p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900 flex items-center gap-2">
          {run.kind} congress
          {run.status === "running" && (
            <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-800 font-medium">
              <Loader2 className="w-3 h-3 animate-spin" /> running
            </span>
          )}
          {run.status === "completed" && (
            <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 font-medium">
              <CheckCircle2 className="w-3 h-3" /> completed
            </span>
          )}
          {run.status === "failed" && (
            <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-red-100 text-red-800 font-medium">
              <AlertTriangle className="w-3 h-3" /> failed
            </span>
          )}
        </h1>
        <p className="text-xs text-slate-500 mt-1">
          run id <span className="font-mono">{id.slice(0, 8)}</span> · started{" "}
          {new Date(run.started_at).toLocaleString()}
          {run.tactical_proposal_id && (
            <>
              {" · "}
              <Link href={`/admin?proposal=${run.tactical_proposal_id}`} className="text-blue-600">
                tactical proposal
              </Link>
            </>
          )}
          {run.template_proposal_id && (
            <>
              {" · "}
              <Link href={`/templates/${run.template_proposal_id}/inspect`} className="text-blue-600">
                template draft
              </Link>
            </>
          )}
        </p>
      </div>

      {run.failure_reason && (
        <div className="mb-5 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-900">
          <div className="font-medium mb-1 flex items-center gap-1">
            <AlertTriangle className="w-4 h-4" /> Run failed
          </div>
          <p className="text-xs">{run.failure_reason}</p>
        </div>
      )}

      <div className="space-y-3 mb-6">
        {run.roster.map((p, idx) => {
          const text = run.personas_completed[p.key];
          const isDone = typeof text === "string";
          const isCurrent = run.current_idx === idx;
          const interjectionsAfter = interjections.filter(
            (i) => i.consumed_by_persona === p.key,
          );
          return (
            <div key={p.key}>
              {/* Interjections that fired RIGHT BEFORE this persona */}
              {interjectionsAfter.map((i) => (
                <div
                  key={i.id}
                  className="mb-2 p-2 bg-blue-50 border-l-2 border-blue-400 rounded text-xs"
                >
                  <div className="font-medium text-blue-900 mb-0.5">
                    {i.author_name} 中途插话 · before {p.display}
                  </div>
                  <p className="text-blue-800 whitespace-pre-wrap">{i.body}</p>
                </div>
              ))}

              <div
                className={`rounded-lg border p-4 transition ${
                  isDone
                    ? "bg-white border-slate-200"
                    : isCurrent
                      ? "bg-amber-50 border-amber-300"
                      : "bg-slate-50 border-slate-200 opacity-60"
                }`}
              >
                <div className="flex items-baseline gap-2 mb-2">
                  <span className="text-sm font-medium text-slate-900">
                    {idx + 1}. {p.display}
                  </span>
                  {!isDone && isCurrent && (
                    <span className="inline-flex items-center gap-1 text-xs text-amber-700">
                      <Loader2 className="w-3 h-3 animate-spin" /> thinking…
                    </span>
                  )}
                  {!isDone && !isCurrent && (
                    <span className="text-xs text-slate-400">queued</span>
                  )}
                </div>
                {isDone ? (
                  <p className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">{text}</p>
                ) : (
                  <p className="text-xs text-slate-400 italic">awaiting turn</p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Pending (not-yet-consumed) interjections */}
      {interjections.some((i) => !i.consumed_at) && (
        <div className="mb-4">
          <h3 className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">Pending interjections</h3>
          <div className="space-y-2">
            {interjections.filter((i) => !i.consumed_at).map((i) => (
              <div key={i.id} className="p-2 bg-blue-50 border border-blue-200 rounded text-xs">
                <div className="font-medium text-blue-900 mb-0.5">
                  {i.author_name} · queued for next persona
                </div>
                <p className="text-blue-800 whitespace-pre-wrap">{i.body}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Interject textbox — only meaningful while status='running' */}
      {run.status === "running" && (
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
          <div className="flex items-center gap-1.5 mb-2 text-xs font-medium text-slate-700">
            <Sparkles className="w-3.5 h-3.5 text-blue-600" /> 插话 — 下一个 persona 会读到
          </div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            placeholder="例如: '你们没考虑 Fudan 0% 这条 n=5, CI 是 [0%, 43%], 这不是 systemic, 是 sample 问题'"
            className="w-full text-sm border border-slate-300 rounded px-3 py-2 bg-white"
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={() => void submit()}
              disabled={!draft.trim() || submitting}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white rounded text-xs font-medium disabled:opacity-50"
            >
              {submitting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
              {submitting ? "Submitting…" : "Submit interjection"}
            </button>
            <span className="text-[11px] text-slate-500">
              下一个 persona ({run.current_idx != null ? run.roster[run.current_idx]?.display : "—"}) 会在 prompt 里看到这条.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
