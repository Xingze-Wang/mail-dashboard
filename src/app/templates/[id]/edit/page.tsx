"use client";

/**
 * /templates/[id]/edit
 *
 * Three-layer template editor (per user framing):
 *   1. Selection logic — segment_default
 *   2. Prompt — intro_prompt (the LLM instruction for paragraph 2)
 *   3. Fixed text — subject + greeting + rep_intro + school_pitch + cta_signoff
 *
 * Doubles as the admin REVIEW surface for pending template_edits:
 * when there are pending edits on this template, they show as
 * diff-strips at the top with Approve/Reject buttons. Admin handles
 * suggestions inline without leaving this page.
 *
 * Role behavior:
 *   - admin       → Save calls PATCH /api/templates/[id]/slots
 *                   (direct mutation; admin's edit IS the approval)
 *                   AND admin sees Approve/Reject controls on
 *                   pending edits.
 *   - sales rep   → Save calls POST /api/templates/[id]/slots
 *                   (queues a template_edits row for admin review;
 *                   nothing mutates production until approved)
 *                   AND sees their own pending edits as read-only.
 *
 * Active templates:
 *   - Admin: editor disabled in-place (must go through queue) BUT
 *     can still approve/reject pending edits, which IS how active
 *     templates change.
 *   - Sales rep: editor enabled (submission goes to queue).
 *
 * AI vs fixed visual: the intro_prompt slot is highlighted with a
 * dashed purple frame and "[AI fills in]" chip — the prose generated
 * by that prompt is what gets sent, not the prompt itself, so the
 * frame signals "this isn't shown to recipients; it instructs Gemini".
 */

import { useEffect, useState, use, useCallback, useMemo } from "react";
import Link from "next/link";
import { Loader2, AlertCircle, Save, GitFork, Lock, Sparkles, ExternalLink, Check, X, Send } from "lucide-react";

interface TemplateSlots {
  id: string;
  name: string;
  status: "active" | "approved_draft" | "proposal" | "archived";
  segment_default: string | null;
  subject_format: string;
  intro_prompt: string;
  greeting_format: string;
  rep_intro_format: string;
  school_pitch_format: string;
  cta_signoff_format: string;
}

interface GateResult {
  slot: string;
  verdict: "pass" | "revise" | "reject" | "error";
  issues: number;
  tone: string;
}

interface PendingEdit {
  id: string;
  slot_key: string;
  old_value: string | null;
  new_value: string | null;
  gate_verdict: "pass" | "revise" | "reject" | "error" | null;
  gate_annotations: {
    issues?: Array<{ severity?: string; description?: string }>;
    tone_assessment?: string;
    scores?: Record<string, number> | null;
  } | null;
  status: "pending" | "approved" | "rejected" | "superseded";
  submitter_name: string;
  submitted_by_rep_id: number;
  submitted_at: string;
  rep_rationale: string | null;
}

interface AuthMe {
  authenticated: boolean;
  repId?: number;
  role?: string;
}

const SLOT_GROUPS = [
  {
    title: "1. Selection logic",
    desc: "决定这个 template 在什么时候被选中. segment_default 是这个 template 默认服务的 segment (cn / overseas / edu / null=fallback).",
    accent: "neutral" as const,
    fields: [
      { key: "segment_default", label: "Segment default", multiline: false, placeholder: "cn / overseas / edu / (空 = 全局)" },
    ] as const,
  },
  {
    title: "2. Prompt (LLM-generated paragraph)",
    desc: "intro_prompt 是 Gemini 收到的指令, 用来生成第 2 段 (个性化开场). 占位符 {{title}} 和 {{abstract}} 会被替换成具体 paper 信息. 这个 prompt 本身不会出现在邮件里 — 真正出现的是 Gemini 用 prompt 生成的内容.",
    accent: "ai" as const,
    fields: [
      { key: "intro_prompt", label: "intro_prompt", multiline: true, rows: 16, placeholder: "" },
    ] as const,
  },
  {
    title: "3. Fixed text (other paragraphs)",
    desc: "其余段落都是模板字符串, 占位符如 {{REP_NAME}} {{closing_name}} {{title}} 等在 send 时刻替换. 不要删占位符.",
    accent: "neutral" as const,
    fields: [
      { key: "subject_format", label: "Subject", multiline: false, placeholder: "Invitation to Apply - {{title}}的潜在算力支持机会" },
      { key: "greeting_format", label: "Greeting", multiline: false, placeholder: "{{first_name_or_you}}你好，" },
      { key: "rep_intro_format", label: "Rep intro paragraph", multiline: true, rows: 4 },
      { key: "school_pitch_format", label: "School + compute pitch", multiline: true, rows: 5 },
      { key: "cta_signoff_format", label: "CTA + signoff", multiline: true, rows: 3 },
    ] as const,
  },
] as const;

const SLOT_LABEL: Record<string, string> = {
  subject_format: "Subject",
  intro_prompt: "Intro prompt (LLM)",
  greeting_format: "Greeting",
  rep_intro_format: "Rep intro paragraph",
  school_pitch_format: "School + compute pitch",
  cta_signoff_format: "CTA + signoff",
  segment_default: "Segment default",
  notes: "Notes",
};

type SlotKey = "segment_default" | "subject_format" | "intro_prompt" | "greeting_format" | "rep_intro_format" | "school_pitch_format" | "cta_signoff_format";

export default function TemplateEditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<TemplateSlots | null>(null);
  const [draft, setDraft] = useState<Partial<TemplateSlots>>({});
  const [rationale, setRationale] = useState("");
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState(false);
  const [me, setMe] = useState<AuthMe | null>(null);
  const [saving, setSaving] = useState(false);
  const [gateResults, setGateResults] = useState<GateResult[]>([]);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingEdit[]>([]);
  const [reviewBusyId, setReviewBusyId] = useState<string | null>(null);

  const isAdmin = me?.role === "admin";

  const refreshPending = useCallback(async () => {
    try {
      const r = await fetch(`/api/templates/${id}/edits?status=pending`, { credentials: "include" });
      if (r.ok) {
        const j = (await r.json()) as { edits: PendingEdit[] };
        setPending(j.edits ?? []);
      }
    } catch {
      // Non-fatal — page still works without the pending list.
    }
  }, [id]);

  useEffect(() => {
    let cancel = false;
    (async () => {
      setLoading(true);
      try {
        // /api/auth/me errors with 401 if not logged in; we still need
        // to render an admin-locked screen in that case so don't bail.
        const meRes = await fetch("/api/auth/me", { credentials: "include" });
        if (!cancel && meRes.ok) {
          setMe((await meRes.json()) as AuthMe);
        }

        // Slot data is admin-gated; sales reps still load via the
        // public-ish library shape. For now slots is admin-only since
        // we want the gating endpoint to be the source of truth, so
        // sales reps see authError. TODO: open up GET to all roles.
        const res = await fetch(`/api/templates/${id}/slots`, { credentials: "include" });
        if (cancel) return;
        if (res.status === 403) { setAuthError(true); return; }
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          alert(`Load failed: ${err.error ?? res.status}`);
          return;
        }
        setData((await res.json()) as TemplateSlots);
        await refreshPending();
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => { cancel = true; };
  }, [id, refreshPending]);

  // Active templates lock the editor for admin (must go through the
  // queue), but the queue *is* enabled for sales reps even on actives —
  // that's the whole point of the diff queue. Archived stays locked
  // for everyone.
  const isLocked = data?.status === "archived" || (data?.status === "active" && isAdmin);

  const setField = useCallback((key: SlotKey, value: string | null) => {
    setDraft((d) => ({ ...d, [key]: value as string }));
  }, []);

  const currentValue = useCallback((key: SlotKey): string => {
    if (key in draft) return (draft as unknown as Record<string, string | null>)[key] ?? "";
    if (!data) return "";
    return ((data as unknown as Record<string, string | null>)[key] ?? "") as string;
  }, [data, draft]);

  const dirty = useMemo(() => {
    if (!data) return false;
    return Object.entries(draft).some(([k, v]) => (data as unknown as Record<string, unknown>)[k] !== v);
  }, [data, draft]);

  const save = useCallback(async () => {
    if (!data || !dirty) return;
    setSaving(true);
    setGateResults([]);
    try {
      // Admin → PATCH (direct mutation). Sales rep → POST (queue).
      const method = isAdmin ? "PATCH" : "POST";
      const body = isAdmin ? draft : { ...draft, rep_rationale: rationale };
      const res = await fetch(`/api/templates/${id}/slots`, {
        method,
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`Save failed: ${err.error ?? res.status}`);
        return;
      }
      const result = await res.json();
      if (isAdmin) {
        setGateResults(result.gate_results ?? []);
      } else {
        // Submitter sees confirmation; gate verdicts attached to each
        // queued row now visible in the pending strip below.
        setGateResults((result.edits ?? []).map((e: { slot_key: string; gate_verdict: string | null; gate_annotations: { issues?: unknown[]; tone_assessment?: string } | null }) => ({
          slot: e.slot_key,
          verdict: (e.gate_verdict ?? "error") as GateResult["verdict"],
          issues: Array.isArray(e.gate_annotations?.issues) ? e.gate_annotations!.issues!.length : 0,
          tone: e.gate_annotations?.tone_assessment ?? "(submitted for admin review)",
        })));
      }
      setSavedAt(new Date().toLocaleTimeString());
      // Refetch state.
      const fresh = await fetch(`/api/templates/${id}/slots`, { credentials: "include" });
      if (fresh.ok) {
        const newData = (await fresh.json()) as TemplateSlots;
        setData(newData);
        setDraft({});
        setRationale("");
      }
      await refreshPending();
    } finally {
      setSaving(false);
    }
  }, [id, dirty, draft, rationale, data, isAdmin, refreshPending]);

  const review = useCallback(async (editId: string, decision: "approve" | "reject", note?: string) => {
    setReviewBusyId(editId);
    try {
      const res = await fetch(`/api/admin/template-edits/${editId}/${decision}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(note ? { review_note: note } : {}),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`${decision} failed: ${err.error ?? res.status}`);
        return;
      }
      // Refetch both the template (it may have changed) and pending list.
      const fresh = await fetch(`/api/templates/${id}/slots`, { credentials: "include" });
      if (fresh.ok) setData((await fresh.json()) as TemplateSlots);
      await refreshPending();
    } finally {
      setReviewBusyId(null);
    }
  }, [id, refreshPending]);

  if (authError) {
    return (
      <div className="max-w-2xl mx-auto p-8">
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
          <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-3" />
          <h1 className="text-xl font-semibold text-red-900 mb-2">Admin only</h1>
          <p className="text-sm text-red-800 mt-2">
            Slot inspection is admin-gated for now. Ask an admin to open this page,
            or use the bench to fork the template into something you can experiment with.
          </p>
        </div>
      </div>
    );
  }

  if (loading || !data) {
    return (
      <div className="p-12 text-center">
        <Loader2 className="w-6 h-6 animate-spin text-slate-400 mx-auto" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      <div className="mb-6 flex items-baseline justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold text-slate-900">{data.name}</h1>
            <span className="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-slate-100 text-slate-700">
              {data.status}
            </span>
            {data.segment_default && (
              <span className="text-xs text-slate-500">seg={data.segment_default}</span>
            )}
            {!isAdmin && (
              <span className="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-blue-100 text-blue-700" title="Your saves go to the admin review queue">
                submit-for-review
              </span>
            )}
          </div>
          <p className="text-sm text-slate-500 mt-1">
            <Link href={`/templates/${id}/inspect`} className="text-blue-600 inline-flex items-center gap-1">
              <ExternalLink className="w-3 h-3" /> 看渲染
            </Link>
            {" · "}
            <Link href={`/templates/${id}/judge`} className="text-blue-600 inline-flex items-center gap-1">
              <ExternalLink className="w-3 h-3" /> 打分
            </Link>
          </p>
        </div>
        <div className="flex items-center gap-3">
          {savedAt && <span className="text-xs text-emerald-600">已保存 {savedAt}</span>}
          {isLocked ? (
            <button
              disabled
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-slate-100 text-slate-400 rounded text-sm cursor-not-allowed"
              title="Active templates can't be edited in place by admin. Use queue or fork."
            >
              <Lock className="w-4 h-4" /> Locked
            </button>
          ) : (
            <button
              onClick={() => void save()}
              disabled={!dirty || saving}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-slate-900 text-white rounded text-sm disabled:opacity-40"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : isAdmin ? <Save className="w-4 h-4" /> : <Send className="w-4 h-4" />}
              {saving ? (isAdmin ? "保存中…" : "提交中…") : dirty ? (isAdmin ? "保存修改" : "提交审核") : "无改动"}
            </button>
          )}
        </div>
      </div>

      {/* Pending edits review strip — admin sees all pending with
          approve/reject; non-admins see their own as read-only. */}
      {pending.length > 0 && (
        <div className="mb-6 space-y-2.5">
          <h2 className="text-sm font-medium text-slate-900 flex items-center gap-1.5">
            <Sparkles className="w-4 h-4 text-amber-600" />
            {isAdmin ? `待审核改动 (${pending.length})` : `已提交待审核 (${pending.length})`}
          </h2>
          {pending.map((p) => {
            const isMine = p.submitted_by_rep_id === me?.repId;
            const verdictColor = p.gate_verdict === "pass"
              ? { bg: "bg-emerald-50", border: "border-emerald-300", text: "text-emerald-800" }
              : p.gate_verdict === "reject"
                ? { bg: "bg-red-50", border: "border-red-300", text: "text-red-800" }
                : { bg: "bg-amber-50", border: "border-amber-300", text: "text-amber-800" };
            return (
              <div
                key={p.id}
                className={`rounded-lg border p-3.5 ${verdictColor.bg} ${verdictColor.border}`}
              >
                <div className="flex items-baseline gap-2 mb-2">
                  <span className="text-xs font-medium text-slate-900">
                    {p.submitter_name} 提议改{" "}
                    <span className="font-mono">{SLOT_LABEL[p.slot_key] ?? p.slot_key}</span>
                  </span>
                  <span className="text-[10px] text-slate-500">
                    {new Date(p.submitted_at).toLocaleString()}
                  </span>
                  {isMine && <span className="text-[10px] text-blue-700">(你的提交)</span>}
                  {p.gate_verdict && (
                    <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded ${verdictColor.text} bg-white/70`}>
                      gate: {p.gate_verdict}
                    </span>
                  )}
                </div>

                {p.rep_rationale && (
                  <p className="text-xs text-slate-700 mb-2 italic">"{p.rep_rationale}"</p>
                )}

                {/* Diff: old → new, side by side */}
                <div className="grid grid-cols-2 gap-2 mb-2">
                  <div className="bg-white/60 rounded p-2">
                    <div className="text-[10px] uppercase font-medium text-slate-500 mb-1">现在</div>
                    <pre className="text-xs whitespace-pre-wrap font-mono text-slate-700 line-clamp-6">
                      {p.old_value ?? "(empty)"}
                    </pre>
                  </div>
                  <div className="bg-white/60 rounded p-2">
                    <div className="text-[10px] uppercase font-medium text-slate-500 mb-1">提议</div>
                    <pre className="text-xs whitespace-pre-wrap font-mono text-slate-900 line-clamp-6">
                      {p.new_value ?? "(empty)"}
                    </pre>
                  </div>
                </div>

                {/* Gate annotations — surface what the gate flagged */}
                {p.gate_annotations?.tone_assessment && (
                  <p className="text-xs text-slate-700 mb-2">
                    <span className="font-medium">Gate:</span> {p.gate_annotations.tone_assessment}
                  </p>
                )}
                {Array.isArray(p.gate_annotations?.issues) && p.gate_annotations!.issues!.length > 0 && (
                  <ul className="text-xs text-slate-700 list-disc pl-5 mb-2 space-y-0.5">
                    {p.gate_annotations!.issues!.slice(0, 4).map((iss, i) => (
                      <li key={i}>
                        {typeof iss === "string"
                          ? iss
                          : (iss as { description?: string }).description ?? JSON.stringify(iss)}
                      </li>
                    ))}
                  </ul>
                )}

                {isAdmin && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => void review(p.id, "approve")}
                      disabled={reviewBusyId === p.id}
                      className="inline-flex items-center gap-1 px-2.5 py-1 bg-emerald-600 text-white rounded text-xs disabled:opacity-50"
                    >
                      <Check className="w-3 h-3" /> Approve
                    </button>
                    <button
                      onClick={() => {
                        const note = window.prompt("Reject 原因 (optional):") ?? undefined;
                        void review(p.id, "reject", note);
                      }}
                      disabled={reviewBusyId === p.id}
                      className="inline-flex items-center gap-1 px-2.5 py-1 bg-white border border-red-300 text-red-700 rounded text-xs hover:bg-red-50 disabled:opacity-50"
                    >
                      <X className="w-3 h-3" /> Reject
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {isLocked && (
        <div className="mb-5 p-3 bg-amber-50 border border-amber-200 rounded text-sm text-amber-900 flex items-start gap-2">
          <Lock className="w-4 h-4 mt-0.5 shrink-0" />
          <div>
            <div className="font-medium mb-1">{data.status === "active" ? "Active template — admin 不能直接改" : "Archived template"}</div>
            <p className="text-amber-800">
              生产 traffic 在用这个 template. 想改的话有两条路:
              {" "}
              <Link href="/templates/bench" className="font-medium underline">去 bench fork</Link>
              {" "}做实验, 或者让 sales 提交一个 edit 进 review queue.
            </p>
          </div>
        </div>
      )}

      {/* Sales rep on a non-locked template gets a banner explaining
          that their submission is queued, not live. */}
      {!isAdmin && !isLocked && (
        <div className="mb-5 p-3 bg-blue-50 border border-blue-200 rounded text-sm text-blue-900">
          <div className="font-medium mb-1 flex items-center gap-1.5">
            <Send className="w-4 h-4" /> 你的修改会进 admin review queue
          </div>
          <p className="text-blue-800 text-xs">
            保存按钮显示 "提交审核". 系统会跑 prose gate (e.g. 检查是不是太销售腔, 有没有 您, etc.)
            然后 admin 看 diff 决定要不要 merge 进 live template. Approve 之前 production 不变.
          </p>
        </div>
      )}

      {/* Save-result gate banner */}
      {gateResults.length > 0 && (
        <div className="mb-5 space-y-2">
          {gateResults.map((g) => (
            <div
              key={g.slot}
              className={`p-3 rounded text-sm flex items-start gap-2 ${
                g.verdict === "pass"
                  ? "bg-emerald-50 border border-emerald-200 text-emerald-900"
                  : g.verdict === "revise"
                    ? "bg-amber-50 border border-amber-200 text-amber-900"
                    : "bg-red-50 border border-red-200 text-red-900"
              }`}
            >
              <Sparkles className="w-4 h-4 mt-0.5 shrink-0" />
              <div>
                <span className="font-medium">{SLOT_LABEL[g.slot] ?? g.slot}</span> ·{" "}
                <span className="uppercase">{g.verdict}</span>
                {g.issues > 0 && <span> · {g.issues} 个问题</span>}
                <p className="text-xs opacity-80 mt-1">{g.tone}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {SLOT_GROUPS.map((group) => (
        <section
          key={group.title}
          className={`mb-7 ${group.accent === "ai" ? "border-2 border-dashed border-purple-300 bg-purple-50/30 rounded-lg p-4" : ""}`}
        >
          <div className="flex items-baseline gap-2">
            <h2 className="text-sm font-medium text-slate-900">{group.title}</h2>
            {group.accent === "ai" && (
              <span className="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 inline-flex items-center gap-1">
                <Sparkles className="w-3 h-3" /> AI fills in
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500 mt-1 mb-3 leading-relaxed">{group.desc}</p>
          <div className="space-y-3">
            {group.fields.map((f) => {
              const val = currentValue(f.key as SlotKey);
              const readOnly = isLocked;
              return (
                <div key={f.key}>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {f.label}
                    <span className="ml-2 text-slate-400 font-mono">{f.key}</span>
                  </label>
                  {f.multiline ? (
                    <textarea
                      value={val}
                      onChange={(e) => setField(f.key as SlotKey, e.target.value)}
                      rows={"rows" in f ? (f.rows as number) : 4}
                      placeholder={"placeholder" in f ? (f.placeholder as string | undefined) : undefined}
                      readOnly={readOnly}
                      className={`w-full text-sm font-mono border rounded px-3 py-2 leading-relaxed ${
                        readOnly ? "bg-slate-50 text-slate-600 border-slate-300" : "bg-white border-slate-300"
                      } ${group.accent === "ai" ? "border-purple-200" : ""}`}
                    />
                  ) : (
                    <input
                      type="text"
                      value={val}
                      onChange={(e) => setField(f.key as SlotKey, e.target.value === "" ? null : e.target.value)}
                      placeholder={"placeholder" in f ? (f.placeholder as string | undefined) : undefined}
                      readOnly={readOnly}
                      className={`w-full text-sm font-mono border rounded px-3 py-2 ${
                        readOnly ? "bg-slate-50 text-slate-600 border-slate-300" : "bg-white border-slate-300"
                      }`}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {/* Rationale only for sales reps submitting; explains the why
          to admin reviewers. Stored on the template_edits row. */}
      {!isAdmin && !isLocked && (
        <div className="mb-5">
          <label className="block text-xs font-medium text-slate-700 mb-1">
            理由 (会显示给 admin reviewer, 可选)
          </label>
          <textarea
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            rows={2}
            placeholder="例如: cn 群体反馈 '同行' 比 'researcher' 自然得多, 想试一下"
            className="w-full text-sm border border-slate-300 rounded px-3 py-2"
          />
        </div>
      )}

      {!isLocked && (
        <div className="mt-6 pt-6 border-t border-slate-200 flex items-center gap-3">
          <button
            onClick={() => void save()}
            disabled={!dirty || saving}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-slate-900 text-white rounded text-sm disabled:opacity-40"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : isAdmin ? <Save className="w-4 h-4" /> : <Send className="w-4 h-4" />}
            {saving ? (isAdmin ? "保存中…" : "提交中…") : dirty ? (isAdmin ? "保存修改" : "提交审核") : "无改动"}
          </button>
          <Link
            href="/templates/bench"
            className="inline-flex items-center gap-1.5 px-3 py-2 border border-slate-300 rounded text-sm hover:bg-slate-50"
          >
            <GitFork className="w-4 h-4" /> 在 bench 创建 fork
          </Link>
        </div>
      )}
    </div>
  );
}
