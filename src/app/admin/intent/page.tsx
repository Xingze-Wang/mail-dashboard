"use client";

/**
 * /admin/intent — single-textarea intent box that replaces:
 *   - Missions Admin (manual daily-plan editing)
 *   - Allocation     (manual lead reassignment)
 *   - Template Candidates (manual template curation)
 *
 * Flow:
 *   1. Admin types a goal in natural language
 *   2. Click "Plan it" → POST /api/admin/plan-intent → server returns
 *      a guided_task plan preview (goal + steps[] + rationale)
 *   3. Admin reviews / edits the plan (steps are editable inline)
 *   4. Click "Submit to Leon" → POST again with submit:true → server
 *      calls proposeGuidedTask which pushes admin a Lark Yes/No card
 *   5. Yes on the Lark card → guided_tasks lifecycle takes over
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, Send, Loader2, AlertCircle } from "lucide-react";

interface PlanStep {
  intent: string;
  verification?: string;
}

interface PlanPreview {
  goal: string;
  rationale?: string;
  steps: PlanStep[];
}

export default function AdminIntentPage() {
  const router = useRouter();
  const [intent, setIntent] = useState("");
  const [constraints, setConstraints] = useState("");
  const [plan, setPlan] = useState<PlanPreview | null>(null);
  const [planning, setPlanning] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<{ task_id: string; inbox_id: string | null } | null>(null);

  async function generatePlan() {
    setError(null);
    setPlan(null);
    setSubmitted(null);
    if (intent.trim().length < 5) {
      setError("写得具体一点 — 至少 5 个字");
      return;
    }
    setPlanning(true);
    try {
      const res = await fetch("/api/admin/plan-intent", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent, constraints: constraints || undefined }),
      });
      const j = await res.json();
      if (!res.ok) {
        setError(j.error ?? `Plan failed: ${res.status}`);
        return;
      }
      setPlan(j.plan);
    } finally {
      setPlanning(false);
    }
  }

  async function submitPlan() {
    if (!plan) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/admin/plan-intent", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent, constraints: constraints || undefined, submit: true, plan }),
      });
      const j = await res.json();
      if (!res.ok) {
        setError(j.error ?? `Submit failed: ${res.status}`);
        return;
      }
      setSubmitted({ task_id: j.task_id, inbox_id: j.inbox_id });
    } finally {
      setSubmitting(false);
    }
  }

  function updateStep(i: number, field: "intent" | "verification", value: string) {
    if (!plan) return;
    const next = { ...plan, steps: [...plan.steps] };
    next.steps[i] = { ...next.steps[i], [field]: value };
    setPlan(next);
  }

  function removeStep(i: number) {
    if (!plan) return;
    setPlan({ ...plan, steps: plan.steps.filter((_, j) => j !== i) });
  }

  function addStep() {
    if (!plan) return;
    setPlan({ ...plan, steps: [...plan.steps, { intent: "" }] });
  }

  return (
    <div className="max-w-3xl mx-auto p-6">
      <div className="flex items-center gap-3 mb-6">
        <Sparkles className="w-7 h-7 text-indigo-600" />
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Intent</h1>
          <p className="text-sm text-slate-500">
            告诉 Leon 你要什么. 它会拆成可执行的多步 plan, 你审一遍再交给它执行.
          </p>
        </div>
      </div>

      {/* Intent input */}
      <div className="space-y-3 mb-4">
        <label className="block">
          <span className="text-sm font-medium text-slate-700 mb-1.5 block">目标</span>
          <textarea
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            disabled={planning || submitting}
            placeholder="e.g. 给所有 cn 的 strong lead 重新归档给 Yujie, 然后给 Yujie 发个 summary"
            rows={4}
            className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-60"
          />
        </label>
        <details>
          <summary className="text-xs text-slate-500 cursor-pointer hover:text-slate-700">
            + 加约束 (optional)
          </summary>
          <textarea
            value={constraints}
            onChange={(e) => setConstraints(e.target.value)}
            disabled={planning || submitting}
            placeholder="e.g. 别动 Leo 的; 只处理 7 天内创建的; 不要超过 50 行写入"
            rows={2}
            className="mt-2 w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </details>
        <div className="flex gap-2">
          <button
            onClick={() => void generatePlan()}
            disabled={planning || submitting || !intent.trim()}
            className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 text-sm disabled:opacity-50"
          >
            {planning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            {plan ? "重新 plan" : "Plan it"}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 px-3 py-2 bg-red-50 border border-red-200 rounded-md flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-red-600 mt-0.5 shrink-0" />
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      {/* Plan preview */}
      {plan && (
        <div className="border border-slate-200 rounded-lg p-4 bg-white mb-4">
          <div className="mb-3">
            <p className="text-xs font-medium text-slate-500 mb-1">GOAL</p>
            <p className="text-slate-900 font-medium">{plan.goal}</p>
          </div>
          {plan.rationale && (
            <div className="mb-4 px-3 py-2 bg-indigo-50 border-l-2 border-indigo-300 rounded-r">
              <p className="text-[11px] font-medium text-indigo-700 mb-0.5">为什么这么拆</p>
              <p className="text-sm text-indigo-900">{plan.rationale}</p>
            </div>
          )}
          <p className="text-xs font-medium text-slate-500 mb-2">STEPS ({plan.steps.length})</p>
          <div className="space-y-2">
            {plan.steps.map((s, i) => (
              <div key={i} className="border border-slate-200 rounded p-2.5 bg-slate-50">
                <div className="flex items-start gap-2">
                  <span className="text-xs font-medium text-slate-500 w-6 mt-1.5 shrink-0">#{i + 1}</span>
                  <div className="flex-1 space-y-1.5">
                    <input
                      type="text"
                      value={s.intent}
                      onChange={(e) => updateStep(i, "intent", e.target.value)}
                      disabled={submitting}
                      className="w-full px-2 py-1 bg-white border border-slate-200 rounded text-sm"
                    />
                    <input
                      type="text"
                      value={s.verification ?? ""}
                      onChange={(e) => updateStep(i, "verification", e.target.value)}
                      placeholder="期望看到什么 (verification, optional)"
                      disabled={submitting}
                      className="w-full px-2 py-1 bg-white border border-slate-200 rounded text-xs text-slate-700 placeholder-slate-400"
                    />
                  </div>
                  <button
                    onClick={() => removeStep(i)}
                    disabled={submitting}
                    className="text-xs text-slate-400 hover:text-red-600"
                    title="Remove step"
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
          </div>
          <button
            onClick={addStep}
            disabled={submitting}
            className="mt-2 text-xs text-indigo-600 hover:text-indigo-700"
          >
            + 加一步
          </button>

          <div className="mt-4 pt-3 border-t border-slate-200 flex items-center gap-2">
            <button
              onClick={() => void submitPlan()}
              disabled={submitting || plan.steps.length === 0}
              className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-md hover:bg-emerald-700 text-sm disabled:opacity-50"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              交给 Leon 执行
            </button>
            <span className="text-xs text-slate-500">
              提交后, Leon 会在你的 Lark 里推一张 Yes/No 卡, Yes 才真的开始跑.
            </span>
          </div>
        </div>
      )}

      {/* Post-submit */}
      {submitted && (
        <div className="border border-emerald-200 bg-emerald-50 rounded-lg p-4">
          <p className="text-sm font-medium text-emerald-900 mb-1.5">
            ✅ 已交给 Leon — 看你的 Lark
          </p>
          <p className="text-xs text-emerald-700 mb-2">
            task_id: <code className="bg-white px-1.5 py-0.5 rounded">{submitted.task_id}</code>
          </p>
          <p className="text-xs text-emerald-700">
            Lark 卡上 Yes 后会开始第一步; 每步完成 Leon 会 DM 你等 ack/correct/abort.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => {
                setIntent("");
                setConstraints("");
                setPlan(null);
                setSubmitted(null);
              }}
              className="text-xs text-emerald-700 underline hover:text-emerald-900"
            >
              新一个任务
            </button>
            <button
              onClick={() => router.push("/admin/inbox")}
              className="text-xs text-emerald-700 underline hover:text-emerald-900"
            >
              去 inbox 看卡
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
