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

  return (
    <div className="max-w-3xl mx-auto p-6">
      <div className="flex items-center gap-3 mb-6">
        <Sparkles className="w-7 h-7 text-indigo-600" />
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Intent</h1>
          <p className="text-sm text-slate-500">
            告诉 Leon 你要什么. 它拆成步骤, 你审一遍, 低风险步骤自动跑, 风险步骤等你 ✓.
          </p>
        </div>
      </div>

      {/* Intent input — hidden once a task is live */}
      {!isLiveTask && (
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
            <summary className="text-xs text-slate-500 cursor-pointer hover:text-slate-700">+ 加约束 (optional)</summary>
            <textarea
              value={constraints}
              onChange={(e) => setConstraints(e.target.value)}
              disabled={planning || submitting}
              placeholder="e.g. 别动 Leo 的; 只处理 7 天内创建的; 不要超过 50 行写入"
              rows={2}
              className="mt-2 w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </details>
          <button
            onClick={() => void generatePlan()}
            disabled={planning || submitting || !intent.trim()}
            className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 text-sm disabled:opacity-50"
          >
            {planning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            {plan ? "重新 plan" : "Plan it"}
          </button>
        </div>
      )}

      {error && (
        <div className="mb-4 px-3 py-2 bg-red-50 border border-red-200 rounded-md flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-red-600 mt-0.5 shrink-0" />
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      {/* Plan preview (pre-submit) */}
      {plan && !isLiveTask && (
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
          <div className="mt-4 pt-3 border-t border-slate-200 flex items-center gap-2">
            <button
              onClick={() => void submitPlan()}
              disabled={submitting || plan.steps.length === 0}
              className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-md hover:bg-emerald-700 text-sm disabled:opacity-50"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              开始执行
            </button>
            <span className="text-xs text-slate-500">⚡ auto 步骤自动跑, 🛡 review 步骤等你 ✓</span>
          </div>
        </div>
      )}

      {/* Live task view */}
      {isLiveTask && task && (
        <div className="space-y-3">
          {/* Header */}
          <div className="border border-slate-200 rounded-lg p-4 bg-white">
            <div className="flex items-start justify-between gap-3 mb-2">
              <p className="text-slate-900 font-medium">{task.goal}</p>
              <StatusBadge status={task.status} />
            </div>
            <p className="text-xs text-slate-500">
              {task.current_step + 1} / {task.steps.length} 步 · 开始于{" "}
              {new Date(task.approved_at ?? task.created_at).toLocaleTimeString()}
            </p>
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
            <div className={`border rounded-lg p-3 ${task.status === "completed" ? "border-emerald-200 bg-emerald-50" : "border-slate-200 bg-slate-50"}`}>
              <p className="text-sm font-medium mb-1">
                {task.status === "completed" ? "🏁 任务完成" : task.status === "aborted" ? "⏹ 任务已 abort" : "⚠️ 任务失败"}
              </p>
              {task.abort_reason && (
                <p className="text-xs text-slate-600">{task.abort_reason}</p>
              )}
              <button onClick={resetAll} className="mt-2 text-xs underline text-slate-700 hover:text-slate-900">
                新一个任务
              </button>
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
  const riskBg = risk === "auto" ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-amber-50 text-amber-700 border-amber-200";
  return (
    <div className="border border-slate-200 rounded p-2.5 bg-slate-50">
      <div className="flex items-start gap-2">
        <span className="text-xs font-medium text-slate-500 w-6 mt-1.5 shrink-0">#{props.index + 1}</span>
        <div className="flex-1 space-y-1.5">
          <input
            type="text" value={props.step.intent}
            onChange={(e) => props.onIntent(e.target.value)}
            className="w-full px-2 py-1 bg-white border border-slate-200 rounded text-sm"
          />
          <input
            type="text" value={props.step.verification ?? ""}
            onChange={(e) => props.onVerification(e.target.value)}
            placeholder="期望看到什么 (verification, optional)"
            className="w-full px-2 py-1 bg-white border border-slate-200 rounded text-xs text-slate-700 placeholder-slate-400"
          />
        </div>
        <button
          onClick={props.onToggleRisk}
          className={`inline-flex items-center gap-1 px-2 py-1 rounded border text-[11px] font-medium ${riskBg} hover:opacity-80`}
          title={risk === "auto" ? "Low risk — auto-runs" : "Risky — requires admin ✓"}
        >
          <RiskIcon className="w-3 h-3" />
          {risk === "auto" ? "auto" : "review"}
        </button>
        <button onClick={props.onRemove} className="text-xs text-slate-400 hover:text-red-600" title="Remove step">
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
    : props.state === "awaiting" ? "border-amber-300 bg-amber-50/40 ring-2 ring-amber-200"
    : "border-slate-200 bg-white";
  return (
    <div className={`border rounded-lg p-3 transition ${border}`}>
      <div className="flex items-start gap-3">
        <StepStateIcon state={props.state} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="text-xs font-medium text-slate-500">#{props.index + 1}</span>
            <RiskChip risk={risk} />
            <StepStateChip state={props.state} />
          </div>
          <p className="text-sm text-slate-900">{props.step.intent}</p>
          {props.step.verification && (
            <p className="text-xs text-slate-500 mt-0.5">期望: {props.step.verification}</p>
          )}
          {props.result && (
            <div className="mt-2 px-2.5 py-1.5 bg-white border border-slate-200 rounded text-xs">
              <p className="font-medium text-slate-700 mb-0.5">结果</p>
              <p className="text-slate-600">{props.result.summary}</p>
            </div>
          )}
          {props.notesForThisStep.length > 0 && (
            <div className="mt-2 space-y-1">
              {props.notesForThisStep.map((n, k) => (
                <div key={k} className="px-2 py-1 bg-amber-50 border-l-2 border-amber-300 rounded-r text-xs text-amber-900">
                  📌 {n.text}
                </div>
              ))}
            </div>
          )}

          {/* Note input + approve/abort — only when awaiting */}
          {props.state === "awaiting" && (
            <div className="mt-3 space-y-2">
              <div className="flex items-center gap-1.5">
                <MessageSquare className="w-3 h-3 text-slate-400" />
                <input
                  type="text"
                  value={props.noteDraft}
                  onChange={(e) => props.onNoteChange(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && props.noteDraft.trim()) props.onSaveNote(); }}
                  placeholder="可选: 给这一步留个 note (按 Enter 保存)"
                  className="flex-1 px-2 py-1 bg-white border border-slate-200 rounded text-xs"
                />
                {props.noteDraft.trim() && (
                  <button onClick={props.onSaveNote} className="text-xs text-indigo-600 underline">save</button>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={props.onApprove}
                  className="inline-flex items-center gap-1 px-3 py-1 bg-emerald-600 text-white rounded text-xs hover:bg-emerald-700"
                >
                  <Check className="w-3 h-3" /> Approve
                </button>
                <button
                  onClick={props.onAbort}
                  className="inline-flex items-center gap-1 px-3 py-1 bg-red-50 text-red-700 border border-red-200 rounded text-xs hover:bg-red-100"
                >
                  <X className="w-3 h-3" /> Abort task
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
