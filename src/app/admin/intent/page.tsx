"use client";

/**
 * /admin/intent — minimalist intent box that matches the dashboard
 * design system. Uses .section-card / .btn / CSS vars instead of
 * Tailwind slate-* + indigo-* (which looked like a different app).
 *
 * Flow:
 *   1. Admin types goal → "Plan it"
 *   2. Server returns plan (goal, rationale, steps[] each with risk_level)
 *   3. If 0 steps → show clarification panel (planner returned questions)
 *   4. If ≥1 steps → preview with editable steps + risk toggle
 *   5. Submit → guided_task created → live polling view
 *   6. risk='review' steps pause for ✓ Approve / ✗ Abort + admin note
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
  ran_at: string;
}
interface AdminNote { step_index: number; text: string; at: string; }
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
  const [taskId, setTaskId] = useState<string | null>(null);
  const [task, setTask] = useState<TaskRow | null>(null);
  const [noteDrafts, setNoteDrafts] = useState<Record<number, string>>({});

  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch(`/api/admin/tasks/${taskId}`, { credentials: "include", cache: "no-store" });
        if (!res.ok) return;
        const j = await res.json();
        if (!cancelled && j.task) setTask(j.task);
      } catch {/* retry next tick */}
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

  const isLiveTask = !!taskId;
  const isTerminal = task && (task.status === "completed" || task.status === "aborted" || task.status === "failed");
  const needsClarification = !!plan && plan.steps.length === 0 && !isLiveTask;

  return (
    <div style={{ maxWidth: 760, margin: "0 auto" }}>
      {/* Page header — matches .page-title pattern (Newsreader serif) */}
      <div style={{ marginBottom: 32 }}>
        <h1 className="page-title" style={{ marginBottom: 6 }}>Intent</h1>
        <p style={{ fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.5, maxWidth: 560 }}>
          告诉 Leon 你要什么 — 它拆成步骤, 你审一遍, ⚡ auto 步骤自动跑, 🛡 review 步骤等你 ✓.
        </p>
      </div>

      {/* Intent input — hidden once a task is live */}
      {!isLiveTask && (
        <div className="section-card" style={{ padding: 24, marginBottom: 16 }}>
          <div style={{ marginBottom: 16 }}>
            <FieldLabel>目标</FieldLabel>
            <textarea
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
              disabled={planning || submitting}
              placeholder="e.g. 给所有 cn 的 strong lead 重新归档给 Yujie, 然后给 Yujie 发个 summary"
              rows={3}
              style={textareaStyle}
            />
          </div>
          <details style={{ marginBottom: 16 }}>
            <summary style={{
              fontSize: 12, color: "var(--text-tertiary)", cursor: "pointer",
              userSelect: "none", padding: "4px 0",
            }}>
              + 加约束 / 红线 (optional)
            </summary>
            <textarea
              value={constraints}
              onChange={(e) => setConstraints(e.target.value)}
              disabled={planning || submitting}
              placeholder="e.g. 别动 Leo 的; 只处理 7 天内创建的; 不要超过 50 行写入"
              rows={2}
              style={{ ...textareaStyle, marginTop: 8 }}
            />
          </details>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <button
              onClick={() => void generatePlan()}
              disabled={planning || submitting || !intent.trim()}
              className="btn btn-primary"
            >
              {planning ? <Loader2 className="animate-spin" style={{ width: 15, height: 15 }} /> : <Sparkles style={{ width: 15, height: 15 }} />}
              {plan ? "重新 plan" : "Plan it"}
            </button>
            {plan && (
              <button
                onClick={resetAll}
                style={{
                  fontSize: 12, color: "var(--text-tertiary)",
                  background: "none", border: "none", cursor: "pointer", padding: "4px 8px",
                }}
              >
                清空重来
              </button>
            )}
          </div>
        </div>
      )}

      {error && (
        <div style={{
          padding: "10px 14px", marginBottom: 16,
          background: "var(--coral-bg)", border: "1px solid var(--coral)",
          borderRadius: "var(--radius-sm)", color: "var(--coral)",
          fontSize: 13, display: "flex", alignItems: "flex-start", gap: 8,
        }}>
          <AlertCircle style={{ width: 16, height: 16, flexShrink: 0, marginTop: 1 }} />
          <span>{error}</span>
        </div>
      )}

      {/* Clarification — planner returned 0 steps with questions */}
      {needsClarification && plan && (
        <div className="section-card" style={{
          padding: 20, marginBottom: 16,
          borderColor: "var(--gold)", background: "var(--gold-bg)",
        }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
            <AlertCircle style={{ width: 20, height: 20, color: "var(--gold)", flexShrink: 0, marginTop: 2 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: "var(--gold)", marginBottom: 6 }}>
                Leon 想先问清楚
              </div>
              <div style={{ fontSize: 13, color: "var(--text)", marginBottom: 4 }}>
                <span style={{ color: "var(--text-tertiary)" }}>理解的目标:</span> {plan.goal}
              </div>
              {plan.rationale && (
                <div style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
                  {plan.rationale}
                </div>
              )}
              <div style={{ fontSize: 12, color: "var(--gold)", marginTop: 10 }}>
                在上面 "目标" 框里补充, 然后点 "重新 plan".
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Plan preview (≥1 step) */}
      {plan && plan.steps.length > 0 && !isLiveTask && (
        <div className="section-card" style={{ padding: 0, marginBottom: 16, overflow: "hidden" }}>
          <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid var(--border-light)" }}>
            <FieldLabel>Goal</FieldLabel>
            <div style={{ fontSize: 15, fontWeight: 500, color: "var(--text)", lineHeight: 1.4 }}>
              {plan.goal}
            </div>
          </div>
          {plan.rationale && (
            <div style={{
              padding: "12px 24px",
              background: "var(--blue-bg)",
              borderBottom: "1px solid var(--border-light)",
              fontSize: 13, color: "var(--blue)", lineHeight: 1.5,
            }}>
              {plan.rationale}
            </div>
          )}
          <div style={{ padding: "16px 24px" }}>
            <FieldLabel>Steps · {plan.steps.length}</FieldLabel>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
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
          <div style={{
            padding: "14px 24px",
            borderTop: "1px solid var(--border-light)",
            background: "var(--bg)",
            display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
          }}>
            <button
              onClick={() => void submitPlan()}
              disabled={submitting}
              className="btn btn-primary"
              style={{ background: "var(--green)", borderColor: "var(--green)" }}
            >
              {submitting ? <Loader2 className="animate-spin" style={{ width: 15, height: 15 }} /> : <Send style={{ width: 15, height: 15 }} />}
              开始执行
            </button>
            <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
              Leon 会在你 Lark DM 推卡确认
            </span>
          </div>
        </div>
      )}

      {/* Live task */}
      {isLiveTask && task && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {/* Visible Lark-approval prompt when stuck in 'planned'.
              Without this the page looks like "running" forever while
              actually waiting on admin to Yes the Lark card. */}
          {task.status === "planned" && (
            <div className="section-card" style={{
              padding: "12px 18px",
              borderLeft: "3px solid var(--gold)",
              background: "var(--gold-bg)",
              fontSize: 13, color: "var(--gold)",
              display: "flex", alignItems: "center", gap: 10,
            }}>
              <span style={{ fontSize: 16 }}>👉</span>
              <span style={{ flex: 1 }}>
                <strong>Open Lark</strong> — Leon sent you a Yes/No card. The task starts when you ✓ it there.
              </span>
            </div>
          )}
          <div className="section-card" style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ padding: "18px 24px" }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 10 }}>
                <div style={{ fontSize: 15, fontWeight: 500, color: "var(--text)", lineHeight: 1.4, flex: 1 }}>
                  {task.goal}
                </div>
                <StatusBadge status={task.status} />
              </div>
              <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
                Step {Math.min(task.current_step + 1, task.steps.length)} / {task.steps.length}
                <span style={{ color: "var(--border)", margin: "0 8px" }}>·</span>
                开始于 {new Date(task.approved_at ?? task.created_at).toLocaleTimeString()}
              </div>
            </div>
            <div style={{ height: 3, background: "var(--border-light)", position: "relative" }}>
              <div style={{
                position: "absolute", inset: 0, right: "auto",
                width: task.status === "completed"
                  ? "100%"
                  : `${Math.min(100, (task.step_results.length / task.steps.length) * 100)}%`,
                background: task.status === "completed" ? "var(--green)"
                  : task.status === "aborted" || task.status === "failed" ? "var(--coral)"
                  : "var(--blue)",
                transition: "width 0.6s ease, background 0.3s ease",
              }} />
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
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

          {isTerminal && (
            <div className="section-card" style={{
              padding: 20,
              borderColor: task.status === "completed" ? "var(--green)"
                : task.status === "failed" ? "var(--coral)" : "var(--border)",
              background: task.status === "completed" ? "var(--green-bg)"
                : task.status === "failed" ? "var(--coral-bg)" : "var(--bg)",
            }}>
              <div style={{
                fontSize: 14, fontWeight: 600, marginBottom: 6,
                color: task.status === "completed" ? "var(--green)"
                  : task.status === "failed" ? "var(--coral)" : "var(--text-secondary)",
              }}>
                {task.status === "completed" ? "🏁 任务完成"
                  : task.status === "aborted" ? "⏹ 任务已 abort"
                  : "⚠️ 任务失败"}
              </div>
              {task.abort_reason && (
                <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 12 }}>
                  {task.abort_reason}
                </div>
              )}
              <div style={{ display: "flex", gap: 16 }}>
                <button onClick={resetAll} style={linkStyle}>新一个任务 →</button>
                <button onClick={() => router.push("/admin/inbox")} style={linkStyleMuted}>去 inbox 看记录</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── small primitives ───────────────────────────────────────────

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)",
      textTransform: "uppercase", letterSpacing: "0.06em",
      marginBottom: 8,
    }}>
      {children}
    </div>
  );
}

const textareaStyle: React.CSSProperties = {
  width: "100%", padding: "10px 12px",
  border: "1px solid var(--border)", borderRadius: "var(--radius-sm)",
  fontSize: 14, lineHeight: 1.55, color: "var(--text)",
  background: "var(--card)",
  fontFamily: "var(--font-body)",
  resize: "vertical",
  outline: "none",
};

const linkStyle: React.CSSProperties = {
  fontSize: 13, fontWeight: 500, color: "var(--text)",
  background: "none", border: "none", cursor: "pointer", padding: 0,
  textDecoration: "underline", textUnderlineOffset: 3,
};
const linkStyleMuted: React.CSSProperties = { ...linkStyle, color: "var(--text-tertiary)", textDecoration: "none" };

// ─── PreviewStepCard ────────────────────────────────────────────

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
  const [hovered, setHovered] = useState(false);

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex", alignItems: "flex-start", gap: 10,
        padding: "10px 12px",
        border: "1px solid var(--border-light)", borderRadius: "var(--radius-sm)",
        background: hovered ? "var(--bg)" : "var(--card)",
        transition: "all 0.15s ease",
      }}
    >
      <div style={{
        fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)",
        width: 18, paddingTop: 8, fontVariantNumeric: "tabular-nums",
      }}>
        {props.index + 1}
      </div>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
        <input
          type="text"
          value={props.step.intent}
          onChange={(e) => props.onIntent(e.target.value)}
          style={{
            width: "100%", padding: "5px 8px",
            border: "1px solid transparent", borderRadius: 4,
            fontSize: 13.5, color: "var(--text)", background: "transparent",
            fontFamily: "var(--font-body)", outline: "none",
          }}
          onFocus={(e) => { e.currentTarget.style.background = "var(--card)"; e.currentTarget.style.borderColor = "var(--border)"; }}
          onBlur={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.borderColor = "transparent"; }}
        />
        <input
          type="text"
          value={props.step.verification ?? ""}
          onChange={(e) => props.onVerification(e.target.value)}
          placeholder="期望看到什么 (optional)"
          style={{
            width: "100%", padding: "5px 8px",
            border: "1px solid transparent", borderRadius: 4,
            fontSize: 12, color: "var(--text-secondary)", background: "transparent",
            fontFamily: "var(--font-body)", outline: "none",
          }}
          onFocus={(e) => { e.currentTarget.style.background = "var(--card)"; e.currentTarget.style.borderColor = "var(--border)"; }}
          onBlur={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.borderColor = "transparent"; }}
        />
      </div>
      <button
        onClick={props.onToggleRisk}
        title={risk === "auto" ? "Low risk — 自动跑" : "Risky — 等你 ✓"}
        style={{
          display: "inline-flex", alignItems: "center", gap: 4,
          padding: "4px 8px", borderRadius: 4,
          fontSize: 11, fontWeight: 500,
          background: risk === "auto" ? "var(--green-bg)" : "var(--gold-bg)",
          color: risk === "auto" ? "var(--green)" : "var(--gold)",
          border: `1px solid ${risk === "auto" ? "var(--green)" : "var(--gold)"}`,
          opacity: 0.85, cursor: "pointer", transition: "opacity 0.15s",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.opacity = "1"; }}
        onMouseLeave={(e) => { e.currentTarget.style.opacity = "0.85"; }}
      >
        <RiskIcon style={{ width: 11, height: 11 }} />
        {risk}
      </button>
      <button
        onClick={props.onRemove}
        title="Remove"
        style={{
          color: "var(--text-tertiary)", background: "none", border: "none",
          fontSize: 18, lineHeight: 1, cursor: "pointer", padding: "2px 6px",
          opacity: hovered ? 0.6 : 0, transition: "opacity 0.15s",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.color = "var(--coral)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.opacity = hovered ? "0.6" : "0"; e.currentTarget.style.color = "var(--text-tertiary)"; }}
      >
        ×
      </button>
    </div>
  );
}

// ─── LiveStepCard ───────────────────────────────────────────────

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
  const accent = stateAccent(props.state);

  return (
    <div className="section-card" style={{
      padding: "14px 18px",
      borderColor: accent.border,
      background: accent.bg,
      boxShadow: props.state === "awaiting" ? "var(--shadow-md)" : "var(--shadow-sm)",
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <StepStateIcon state={props.state} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
            <span style={{
              fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)",
              fontVariantNumeric: "tabular-nums",
            }}>
              #{props.index + 1}
            </span>
            <RiskChip risk={risk} />
            <StepStateChip state={props.state} />
          </div>
          <div style={{ fontSize: 13.5, color: "var(--text)", lineHeight: 1.45 }}>{props.step.intent}</div>
          {props.step.verification && (
            <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 4 }}>
              <span style={{ color: "var(--text-tertiary)" }}>期望:</span> {props.step.verification}
            </div>
          )}
          {props.result && (
            <div style={{
              marginTop: 10, padding: "8px 12px",
              background: "var(--card)", border: "1px solid var(--border-light)",
              borderRadius: "var(--radius-sm)", fontSize: 12.5,
            }}>
              <div style={{
                fontSize: 10, fontWeight: 600, color: "var(--text-tertiary)",
                textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4,
              }}>结果</div>
              <div style={{ color: "var(--text)", lineHeight: 1.5 }}>{props.result.summary}</div>
            </div>
          )}
          {props.notesForThisStep.length > 0 && (
            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
              {props.notesForThisStep.map((n, k) => (
                <div key={k} style={{
                  padding: "6px 10px", fontSize: 12,
                  background: "var(--gold-bg)", color: "var(--gold)",
                  borderLeft: "2px solid var(--gold)",
                  borderRadius: "0 4px 4px 0",
                }}>
                  📌 {n.text}
                </div>
              ))}
            </div>
          )}
          {props.state === "awaiting" && (
            <div style={{
              marginTop: 12, paddingTop: 12,
              borderTop: "1px solid var(--gold)",
              display: "flex", flexDirection: "column", gap: 10,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <MessageSquare style={{ width: 14, height: 14, color: "var(--text-tertiary)", flexShrink: 0 }} />
                <input
                  type="text"
                  value={props.noteDraft}
                  onChange={(e) => props.onNoteChange(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && props.noteDraft.trim()) props.onSaveNote(); }}
                  placeholder="可选: note (按 Enter)"
                  style={{
                    flex: 1, padding: "5px 10px", fontSize: 12,
                    border: "1px solid var(--border)", borderRadius: 4,
                    background: "var(--card)", outline: "none",
                    fontFamily: "var(--font-body)",
                  }}
                />
                {props.noteDraft.trim() && (
                  <button
                    onClick={props.onSaveNote}
                    style={{
                      fontSize: 12, fontWeight: 500, color: "var(--gold)",
                      background: "none", border: "none", cursor: "pointer", padding: "4px 6px",
                    }}
                  >save</button>
                )}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={props.onApprove} className="btn btn-primary" style={{
                  background: "var(--green)", borderColor: "var(--green)",
                  fontSize: 12.5, padding: "6px 14px",
                }}>
                  <Check style={{ width: 14, height: 14 }} /> Approve
                </button>
                <button onClick={props.onAbort} className="btn btn-danger" style={{
                  fontSize: 12.5, padding: "6px 14px",
                }}>
                  <X style={{ width: 14, height: 14 }} /> Abort task
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function stateAccent(state: StepState): { border: string; bg: string } {
  switch (state) {
    case "done":     return { border: "var(--green)",       bg: "var(--green-bg)" };
    case "failed":   return { border: "var(--coral)",       bg: "var(--coral-bg)" };
    case "running":  return { border: "var(--blue)",        bg: "var(--blue-bg)" };
    case "awaiting": return { border: "var(--gold)",        bg: "var(--gold-bg)" };
    default:         return { border: "var(--border-light)", bg: "var(--card)" };
  }
}

function StepStateIcon({ state }: { state: StepState }) {
  if (state === "done") return <Check style={{ width: 18, height: 18, color: "var(--green)", flexShrink: 0, marginTop: 2 }} />;
  if (state === "failed") return <X style={{ width: 18, height: 18, color: "var(--coral)", flexShrink: 0, marginTop: 2 }} />;
  if (state === "running") return <Loader2 className="animate-spin" style={{ width: 18, height: 18, color: "var(--blue)", flexShrink: 0, marginTop: 2 }} />;
  if (state === "awaiting") return <ShieldAlert style={{ width: 18, height: 18, color: "var(--gold)", flexShrink: 0, marginTop: 2 }} />;
  return <div style={{
    width: 18, height: 18, borderRadius: "50%",
    border: "1.5px solid var(--border)", flexShrink: 0, marginTop: 2,
  }} />;
}

function RiskChip({ risk }: { risk: "auto" | "review" }) {
  const isAuto = risk === "auto";
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 3,
      padding: "1px 6px", borderRadius: 3,
      fontSize: 10, fontWeight: 500,
      background: isAuto ? "var(--green-bg)" : "var(--gold-bg)",
      color: isAuto ? "var(--green)" : "var(--gold)",
    }}>
      {isAuto ? <Zap style={{ width: 10, height: 10 }} /> : <ShieldAlert style={{ width: 10, height: 10 }} />}
      {risk}
    </span>
  );
}

function StepStateChip({ state }: { state: StepState }) {
  const map: Record<StepState, { label: string; color: string; bg: string }> = {
    pending:  { label: "pending",  color: "var(--text-tertiary)", bg: "var(--border-light)" },
    running:  { label: "running…", color: "var(--blue)",          bg: "var(--blue-bg)" },
    awaiting: { label: "needs ✓",  color: "var(--gold)",          bg: "var(--gold-bg)" },
    done:     { label: "done",     color: "var(--green)",         bg: "var(--green-bg)" },
    failed:   { label: "failed",   color: "var(--coral)",         bg: "var(--coral-bg)" },
  };
  const m = map[state];
  return (
    <span style={{
      display: "inline-flex", padding: "1px 6px", borderRadius: 3,
      fontSize: 10, fontWeight: 500, background: m.bg, color: m.color,
    }}>{m.label}</span>
  );
}

function StatusBadge({ status }: { status: TaskRow["status"] }) {
  const map: Record<TaskRow["status"], { label: string; color: string; bg: string }> = {
    // 'planned' means waiting for admin to Yes the Lark card — admin
    // would think the UI is just "doing nothing". Better label.
    planned:   { label: "Awaiting Lark ✓", color: "var(--gold)", bg: "var(--gold-bg)" },
    running:   { label: "Running",   color: "var(--blue)",          bg: "var(--blue-bg)" },
    paused:    { label: "Paused",    color: "var(--gold)",          bg: "var(--gold-bg)" },
    completed: { label: "Completed", color: "var(--green)",         bg: "var(--green-bg)" },
    aborted:   { label: "Aborted",   color: "var(--coral)",         bg: "var(--coral-bg)" },
    failed:    { label: "Failed",    color: "var(--coral)",         bg: "var(--coral-bg)" },
  };
  const m = map[status];
  return (
    <span style={{
      display: "inline-flex", padding: "3px 10px", borderRadius: 12,
      fontSize: 11, fontWeight: 500, background: m.bg, color: m.color,
    }}>{m.label}</span>
  );
}
