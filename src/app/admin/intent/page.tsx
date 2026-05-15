"use client";

/**
 * /admin/intent — intent box + per-step approval flow.
 *
 * Three phases:
 *   1. Type intent → "Plan it" → preview cards (still client-side, not yet
 *      submitted)
 *   2. Submit plan → server creates guided_task, returns task_id; client
 *      starts polling /api/admin/tasks/<id>
 *   3. Live: each step renders as a card with state (pending/running/done/
 *      failed). Steps with risk_level='review' show ✓ Approve / ✗ Abort
 *      buttons when awaiting_step_ack matches. Admin can drop notes
 *      before approving.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Sparkles, Send, Loader2, AlertCircle, Check, X, Zap, ShieldAlert, MessageSquare,
} from "lucide-react";

interface PlanStep {
  intent: string;
  verification?: string;
  risk_level?: "auto" | "review";
}
interface PlanPreview {
  goal: string;
  rationale?: string;
  steps: PlanStep[];
}

interface StepResult {
  ok: boolean;
  summary: string;
  evidence?: unknown;
  ran_at: string;
  ack?: "continue" | "modified" | "aborted";
}

interface AdminNote {
  step_index: number;
  text: string;
  at: string;
}

interface TaskRow {
  id: string;
  goal: string;
  steps: PlanStep[];
  step_results: StepResult[];
  current_step: number;
  status: "planned" | "running" | "paused" | "completed" | "aborted" | "failed";
  awaiting_step_ack: number | null;
  admin_notes: AdminNote[];
  created_at: string;
  approved_at: string | null;
  completed_at: string | null;
  abort_reason: string | null;
}

export default function AdminIntentPage() {
  const router = useRouter();
  const [intent, setIntent] = useState("");
  const [constraints, setConstraints] = useState("");
  const [plan, setPlan] = useState<PlanPreview | null>(null);
  const [planning, setPlanning] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // After submit, we track the actual running task
  const [taskId, setTaskId] = useState<string | null>(null);
  const [task, setTask] = useState<TaskRow | null>(null);
  const [noteDrafts, setNoteDrafts] = useState<Record<number, string>>({});

  // Poll the task while it's running
  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch(`/api/admin/tasks/${taskId}`, { credentials: "include", cache: "no-store" });
        if (!res.ok) return;
        const j = await res.json();
        if (!cancelled && j.task) setTask(j.task);
      } catch {/* network blip, retry next tick */}
    }
    void poll();
    const iv = setInterval(poll, 2500);
    return () => { cancelled = true; clearInterval(iv); };
  }, [taskId]);

  async function generatePlan() {
    setError(null); setPlan(null); setTask(null); setTaskId(null);
    if (intent.trim().length < 5) { setError("写得具体一点 — 至少 5 个字"); return; }
    setPlanning(true);
    try {
      const res = await fetch("/api/admin/plan-intent", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent, constraints: constraints || undefined }),
      });
      const j = await res.json();
      if (!res.ok) { setError(j.error ?? `Plan failed: ${res.status}`); return; }
      setPlan(j.plan);
    } finally { setPlanning(false); }
  }

  async function submitPlan() {
    if (!plan) return;
    setError(null); setSubmitting(true);
    try {
      const res = await fetch("/api/admin/plan-intent", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent, constraints: constraints || undefined, submit: true, plan }),
      });
      const j = await res.json();
      if (!res.ok) { setError(j.error ?? `Submit failed: ${res.status}`); return; }
      setTaskId(j.task_id);
    } finally { setSubmitting(false); }
  }

  async function ackStep(action: "continue" | "aborted" | "modified") {
    if (!taskId) return;
    await fetch(`/api/admin/tasks/${taskId}/ack`, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ack: action }),
    });
  }

  async function saveNote(stepIndex: number) {
    const text = noteDrafts[stepIndex]?.trim();
    if (!text || !taskId) return;
    await fetch(`/api/admin/tasks/${taskId}/note`, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step_index: stepIndex, text }),
    });
    setNoteDrafts((d) => ({ ...d, [stepIndex]: "" }));
  }

  function resetAll() {
    setIntent(""); setConstraints(""); setPlan(null); setTaskId(null); setTask(null); setNoteDrafts({});
  }

  function updatePreviewStep(i: number, field: "intent" | "verification", value: string) {
    if (!plan) return;
    const next = { ...plan, steps: [...plan.steps] };
    next.steps[i] = { ...next.steps[i], [field]: value };
    setPlan(next);
  }
  function removePreviewStep(i: number) {
    if (!plan) return;
    setPlan({ ...plan, steps: plan.steps.filter((_, j) => j !== i) });
  }
  function togglePreviewRisk(i: number) {
    if (!plan) return;
    const next = { ...plan, steps: [...plan.steps] };
    next.steps[i] = { ...next.steps[i], risk_level: next.steps[i].risk_level === "auto" ? "review" : "auto" };
    setPlan(next);
  }

  // —————————————————————————————————————————————————————————————————————
  // RENDER
  // —————————————————————————————————————————————————————————————————————

  const isLiveTask = !!taskId;
  const isTerminal = task && (task.status === "completed" || task.status === "aborted" || task.status === "failed");

  // Needs-clarification = planner returned 0 steps. Treat as a question
  // back to admin, not a failed plan.
  const needsClarification = !!plan && plan.steps.length === 0;

  return (
    <div className="max-w-3xl mx-auto px-6 py-6">
      {/* Header */}
      <div className="flex items-start gap-3 pb-4 mb-6 border-b border-slate-200">
        <div className="w-9 h-9 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center shrink-0">
          <Sparkles className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0 pt-0.5">
          <h1 className="text-xl font-semibold text-slate-900 leading-tight">Intent</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            告诉 Leon 你要什么 — 它拆成步骤, 你审一遍, ⚡ auto 步骤自动跑, 🛡 review 步骤等你 ✓.
          </p>
        </div>
      </div>

      {/* Intent input — hidden once a task is live */}
      {!isLiveTask && (
        <div className="bg-white border border-slate-200 rounded-lg shadow-sm p-5 mb-4">
          <label className="block mb-3">
            <span className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2 block">目标</span>
            <textarea
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
              disabled={planning || submitting}
              placeholder="e.g. 给所有 cn 的 strong lead 重新归档给 Yujie, 然后给 Yujie 发个 summary"
              rows={3}
              className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 disabled:opacity-60 disabled:bg-slate-50"
            />
          </label>
          <details className="mb-4">
            <summary className="text-xs text-slate-500 cursor-pointer hover:text-slate-700 select-none">
              + 加约束 / 红线 (optional)
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
          <div className="flex items-center justify-between gap-2">
            <button
              onClick={() => void generatePlan()}
              disabled={planning || submitting || !intent.trim()}
              className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 text-sm font-medium shadow-sm disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              {planning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
              {plan ? "重新 plan" : "Plan it"}
            </button>
            {plan && (
              <button
                onClick={resetAll}
                className="text-xs text-slate-500 hover:text-slate-700"
              >
                清空重来
              </button>
            )}
          </div>
        </div>
      )}

      {error && (
        <div className="mb-4 px-3 py-2.5 bg-red-50 border border-red-200 rounded-md flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-red-600 mt-0.5 shrink-0" />
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      {/* Clarification needed (0-step plan) */}
      {needsClarification && !isLiveTask && plan && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-4 shadow-sm">
          <div className="flex items-start gap-2.5">
            <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-amber-900 mb-1">Leon 想先问清楚</p>
              <p className="text-sm text-amber-900 mb-1">
                <span className="text-amber-700 text-xs">理解的目标:</span> {plan.goal}
              </p>
              {plan.rationale && (
                <p className="text-sm text-amber-900 leading-relaxed">{plan.rationale}</p>
              )}
              <p className="text-xs text-amber-700 mt-2">
                在上面的 "目标" 框里补充细节, 然后再点 "重新 plan".
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Plan preview (pre-submit, ≥1 step) */}
      {plan && plan.steps.length > 0 && !isLiveTask && (
        <div className="bg-white border border-slate-200 rounded-lg shadow-sm overflow-hidden mb-4">
          <div className="px-5 py-3 border-b border-slate-100 bg-slate-50">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Goal</p>
            <p className="text-slate-900 font-medium leading-snug">{plan.goal}</p>
          </div>
          {plan.rationale && (
            <div className="px-5 py-3 bg-indigo-50/50 border-b border-slate-100">
              <p className="text-[11px] font-medium text-indigo-700 mb-0.5 uppercase tracking-wide">为什么这么拆</p>
              <p className="text-sm text-indigo-900 leading-relaxed">{plan.rationale}</p>
            </div>
          )}
          <div className="px-5 py-3">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2.5">
              Steps · {plan.steps.length}
            </p>
            <div className="space-y-2">
              {plan.steps.map((s, i) => (
                <PreviewStepCard
                  key={i}
                  index={i}
                  step={s}
                  onIntent={(v) => updatePreviewStep(i, "intent", v)}
                  onVerification={(v) => updatePreviewStep(i, "verification", v)}
                  onToggleRisk={() => togglePreviewRisk(i)}
                  onRemove={() => removePreviewStep(i)}
                />
              ))}
            </div>
          </div>
          <div className="px-5 py-3 bg-slate-50 border-t border-slate-100 flex items-center justify-between gap-2">
            <button
              onClick={() => void submitPlan()}
              disabled={submitting}
              className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-md hover:bg-emerald-700 text-sm font-medium shadow-sm disabled:opacity-50 transition"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              开始执行
            </button>
            <span className="text-xs text-slate-500">提交后 Leon 在你 Lark 推卡确认</span>
          </div>
        </div>
      )}

      {/* Live task view */}
      {isLiveTask && task && (
        <div className="space-y-3">
          {/* Task header — progress bar + status */}
          <div className="bg-white border border-slate-200 rounded-lg shadow-sm overflow-hidden">
            <div className="px-5 py-3.5">
              <div className="flex items-start justify-between gap-3 mb-2.5">
                <p className="text-slate-900 font-medium leading-snug">{task.goal}</p>
                <StatusBadge status={task.status} />
              </div>
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <span>
                  Step {Math.min(task.current_step + 1, task.steps.length)} / {task.steps.length}
                </span>
                <span className="text-slate-300">·</span>
                <span>开始于 {new Date(task.approved_at ?? task.created_at).toLocaleTimeString()}</span>
              </div>
            </div>
            {/* Progress bar */}
            <div className="h-1 bg-slate-100 relative overflow-hidden">
              <div
                className={`absolute inset-y-0 left-0 transition-all duration-500 ${
                  task.status === "completed" ? "bg-emerald-500"
                  : task.status === "aborted" || task.status === "failed" ? "bg-red-400"
                  : "bg-indigo-500"
                }`}
                style={{
                  width: task.status === "completed"
                    ? "100%"
                    : `${Math.min(100, (task.step_results.length / task.steps.length) * 100)}%`,
                }}
              />
            </div>
          </div>

          {/* Step cards */}
          <div className="space-y-2">
            {task.steps.map((s, i) => {
              const result = task.step_results[i];
              const isCurrent = i === task.current_step && task.status !== "completed";
              const isAwaitingThis = task.awaiting_step_ack === i;
              const stepState: StepState = result
                ? (result.ok ? "done" : "failed")
                : isAwaitingThis
                ? "awaiting"
                : isCurrent && task.status === "running"
                ? "running"
                : "pending";
              return (
                <LiveStepCard
                  key={i}
                  index={i}
                  step={s}
                  state={stepState}
                  result={result}
                  notesForThisStep={task.admin_notes.filter((n) => n.step_index === i)}
                  noteDraft={noteDrafts[i] ?? ""}
                  onNoteChange={(v) => setNoteDrafts((d) => ({ ...d, [i]: v }))}
                  onSaveNote={() => void saveNote(i)}
                  onApprove={isAwaitingThis ? () => void ackStep("continue") : undefined}
                  onAbort={isAwaitingThis ? () => void ackStep("aborted") : undefined}
                />
              );
            })}
          </div>

          {/* Terminal state */}
          {isTerminal && (
            <div className={`border rounded-lg shadow-sm p-4 ${
              task.status === "completed" ? "border-emerald-200 bg-emerald-50"
              : task.status === "aborted" ? "border-slate-200 bg-slate-50"
              : "border-red-200 bg-red-50"
            }`}>
              <p className={`text-sm font-medium mb-1.5 ${
                task.status === "completed" ? "text-emerald-900"
                : task.status === "aborted" ? "text-slate-700"
                : "text-red-900"
              }`}>
                {task.status === "completed" ? "🏁 任务完成"
                : task.status === "aborted" ? "⏹ 任务已 abort"
                : "⚠️ 任务失败"}
              </p>
              {task.abort_reason && (
                <p className="text-xs text-slate-600 mb-2">{task.abort_reason}</p>
              )}
              <div className="flex items-center gap-3">
                <button
                  onClick={resetAll}
                  className="text-xs font-medium text-indigo-700 hover:text-indigo-900 underline-offset-2 hover:underline"
                >
                  新一个任务 →
                </button>
                <button
                  onClick={() => router.push("/admin/inbox")}
                  className="text-xs text-slate-500 hover:text-slate-700"
                >
                  去 inbox 看记录
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── components ─────────────────────────────────────────────────────────

function PreviewStepCard(props: {
  index: number;
  step: PlanStep;
  onIntent: (v: string) => void;
  onVerification: (v: string) => void;
  onToggleRisk: () => void;
  onRemove: () => void;
}) {
  const risk = props.step.risk_level ?? "review";
  const RiskIcon = risk === "auto" ? Zap : ShieldAlert;
  const riskBg = risk === "auto"
    ? "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100"
    : "bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100";
  return (
    <div className="border border-slate-200 rounded-md p-2.5 bg-white hover:border-slate-300 transition group">
      <div className="flex items-start gap-2.5">
        <span className="text-xs font-semibold text-slate-400 w-5 mt-2 shrink-0 tabular-nums">{props.index + 1}</span>
        <div className="flex-1 min-w-0 space-y-1.5">
          <input
            type="text"
            value={props.step.intent}
            onChange={(e) => props.onIntent(e.target.value)}
            className="w-full px-2 py-1 bg-transparent border border-transparent rounded text-sm text-slate-900 hover:border-slate-200 focus:outline-none focus:border-indigo-300 focus:bg-white"
          />
          <input
            type="text"
            value={props.step.verification ?? ""}
            onChange={(e) => props.onVerification(e.target.value)}
            placeholder="期望看到什么 (optional)"
            className="w-full px-2 py-1 bg-transparent border border-transparent rounded text-xs text-slate-600 placeholder-slate-400 hover:border-slate-200 focus:outline-none focus:border-indigo-300 focus:bg-white"
          />
        </div>
        <button
          onClick={props.onToggleRisk}
          className={`inline-flex items-center gap-1 px-2 py-1 rounded border text-[11px] font-medium transition shrink-0 ${riskBg}`}
          title={risk === "auto" ? "Low risk — 自动跑" : "Risky — 等你 ✓"}
        >
          <RiskIcon className="w-3 h-3" />
          {risk}
        </button>
        <button
          onClick={props.onRemove}
          className="text-slate-300 hover:text-red-500 text-base leading-none shrink-0 px-1 opacity-0 group-hover:opacity-100 transition"
          title="Remove step"
        >
          ×
        </button>
      </div>
    </div>
  );
}

type StepState = "pending" | "running" | "awaiting" | "done" | "failed";

function LiveStepCard(props: {
  index: number;
  step: PlanStep;
  state: StepState;
  result?: StepResult;
  notesForThisStep: AdminNote[];
  noteDraft: string;
  onNoteChange: (v: string) => void;
  onSaveNote: () => void;
  onApprove?: () => void;
  onAbort?: () => void;
}) {
  const risk = props.step.risk_level ?? "review";
  const border =
    props.state === "done" ? "border-emerald-200 bg-emerald-50/40"
    : props.state === "failed" ? "border-red-200 bg-red-50/40"
    : props.state === "running" ? "border-indigo-200 bg-indigo-50/40"
    : props.state === "awaiting" ? "border-amber-300 bg-amber-50/40 ring-2 ring-amber-200/60 shadow-sm"
    : "border-slate-200 bg-white";
  return (
    <div className={`border rounded-lg p-3.5 transition ${border}`}>
      <div className="flex items-start gap-3">
        <StepStateIcon state={props.state} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap mb-1.5">
            <span className="text-xs font-semibold text-slate-400 tabular-nums">#{props.index + 1}</span>
            <RiskChip risk={risk} />
            <StepStateChip state={props.state} />
          </div>
          <p className="text-sm text-slate-900 leading-snug">{props.step.intent}</p>
          {props.step.verification && (
            <p className="text-xs text-slate-500 mt-1">
              <span className="text-slate-400">期望:</span> {props.step.verification}
            </p>
          )}
          {props.result && (
            <div className="mt-2.5 px-2.5 py-2 bg-white border border-slate-200 rounded-md text-xs">
              <p className="font-medium text-slate-500 uppercase tracking-wide mb-1 text-[10px]">结果</p>
              <p className="text-slate-700 leading-relaxed">{props.result.summary}</p>
            </div>
          )}
          {props.notesForThisStep.length > 0 && (
            <div className="mt-2 space-y-1">
              {props.notesForThisStep.map((n, k) => (
                <div key={k} className="px-2.5 py-1.5 bg-amber-50 border-l-2 border-amber-400 rounded-r text-xs text-amber-900">
                  <span className="text-amber-600 mr-1">📌</span> {n.text}
                </div>
              ))}
            </div>
          )}

          {/* Note input + approve/abort — only when awaiting */}
          {props.state === "awaiting" && (
            <div className="mt-3 pt-3 border-t border-amber-200 space-y-2.5">
              <div className="flex items-center gap-2">
                <MessageSquare className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                <input
                  type="text"
                  value={props.noteDraft}
                  onChange={(e) => props.onNoteChange(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && props.noteDraft.trim()) props.onSaveNote(); }}
                  placeholder="可选: 给这一步留个 note (按 Enter 保存)"
                  className="flex-1 px-2 py-1 bg-white border border-slate-200 rounded text-xs focus:outline-none focus:border-amber-400"
                />
                {props.noteDraft.trim() && (
                  <button
                    onClick={props.onSaveNote}
                    className="text-xs font-medium text-amber-700 hover:text-amber-900"
                  >
                    save
                  </button>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={props.onApprove}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white rounded-md text-xs font-medium shadow-sm hover:bg-emerald-700 transition"
                >
                  <Check className="w-3.5 h-3.5" /> Approve
                </button>
                <button
                  onClick={props.onAbort}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white text-red-700 border border-red-200 rounded-md text-xs font-medium hover:bg-red-50 transition"
                >
                  <X className="w-3.5 h-3.5" /> Abort task
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StepStateIcon({ state }: { state: StepState }) {
  if (state === "done") return <Check className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />;
  if (state === "failed") return <X className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />;
  if (state === "running") return <Loader2 className="w-5 h-5 text-indigo-600 shrink-0 mt-0.5 animate-spin" />;
  if (state === "awaiting") return <ShieldAlert className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />;
  return <div className="w-5 h-5 rounded-full border-2 border-slate-300 shrink-0 mt-0.5" />;
}

function RiskChip({ risk }: { risk: "auto" | "review" }) {
  if (risk === "auto") return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-emerald-100 text-emerald-700">
      <Zap className="w-2.5 h-2.5" /> auto
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-amber-100 text-amber-700">
      <ShieldAlert className="w-2.5 h-2.5" /> review
    </span>
  );
}

function StepStateChip({ state }: { state: StepState }) {
  const map: Record<StepState, { label: string; klass: string }> = {
    pending:   { label: "pending",   klass: "bg-slate-100 text-slate-600" },
    running:   { label: "running…",  klass: "bg-indigo-100 text-indigo-700" },
    awaiting:  { label: "needs ✓",   klass: "bg-amber-100 text-amber-700" },
    done:      { label: "done",      klass: "bg-emerald-100 text-emerald-700" },
    failed:    { label: "failed",    klass: "bg-red-100 text-red-700" },
  };
  const m = map[state];
  return <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] ${m.klass}`}>{m.label}</span>;
}

function StatusBadge({ status }: { status: TaskRow["status"] }) {
  const map: Record<TaskRow["status"], { label: string; klass: string }> = {
    planned:   { label: "Planned",   klass: "bg-slate-100 text-slate-600" },
    running:   { label: "Running",   klass: "bg-indigo-100 text-indigo-700" },
    paused:    { label: "Paused",    klass: "bg-amber-100 text-amber-700" },
    completed: { label: "Completed", klass: "bg-emerald-100 text-emerald-700" },
    aborted:   { label: "Aborted",   klass: "bg-red-100 text-red-700" },
    failed:    { label: "Failed",    klass: "bg-red-100 text-red-700" },
  };
  const m = map[status];
  return <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium ${m.klass}`}>{m.label}</span>;
}
