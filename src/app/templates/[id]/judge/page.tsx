"use client";

/**
 * /templates/[id]/judge
 *
 * Human admin rates a template on the same 6-dim rubric the editor LLM
 * used. Side-by-side display of the AI scores so the admin can
 * deliberately disagree (or agree) and the diff becomes calibration
 * data.
 *
 * One human rating per admin, but multiple admins can rate the same
 * template independently. The page shows the current admin's row
 * pre-filled if they've rated before, plus all other humans' rows
 * collapsed below.
 */

import { useEffect, useState, use, useCallback } from "react";
import Link from "next/link";
import { Loader2, AlertCircle, Check } from "lucide-react";

const DIMS = [
  { key: "politeness",       label: "Politeness",       help: "卑微 1 ↔ 平等 10 ↔ 傲慢 1" },
  { key: "clarity",          label: "Clarity",          help: "30 秒能不能 get 到 — 不清楚 1, 清楚 10" },
  { key: "peer_register",    label: "Peer register",    help: "销售腔 1 ↔ 平等同行 10" },
  { key: "brand_fit",        label: "Brand fit",        help: "务实/坦然/简朴/谦逊 四性贴合度" },
  { key: "factual_accuracy", label: "Factual accuracy", help: "Program facts 是否符合事实" },
  { key: "naturalness",      label: "Naturalness",      help: "LLM 一眼看出 1 ↔ 真人写的 10" },
] as const;
type Dim = typeof DIMS[number]["key"];

interface Rating {
  rater_kind: "ai" | "human";
  rater_id: number | null;
  model_id?: string | null;
  politeness: number;
  clarity: number;
  peer_register: number;
  brand_fit: number;
  factual_accuracy: number;
  naturalness: number;
  reasoning: string | null;
  updated_at: string;
}

interface JudgeResponse {
  ai_rating: Rating | null;
  my_rating: Rating | null;
  all_human_ratings: Rating[];
  n_humans: number;
}

export default function JudgePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<JudgeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState(false);
  const [scores, setScores] = useState<Record<Dim, number>>({
    politeness: 7, clarity: 7, peer_register: 7, brand_fit: 7, factual_accuracy: 7, naturalness: 7,
  });
  const [reasoning, setReasoning] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/templates/${id}/judge`, { credentials: "include" });
        if (cancel) return;
        if (res.status === 403) { setAuthError(true); return; }
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          alert(`Load failed: ${err.error ?? res.status}`);
          return;
        }
        const d = (await res.json()) as JudgeResponse;
        setData(d);
        if (d.my_rating) {
          setScores({
            politeness: d.my_rating.politeness,
            clarity: d.my_rating.clarity,
            peer_register: d.my_rating.peer_register,
            brand_fit: d.my_rating.brand_fit,
            factual_accuracy: d.my_rating.factual_accuracy,
            naturalness: d.my_rating.naturalness,
          });
          setReasoning(d.my_rating.reasoning ?? "");
        }
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => { cancel = true; };
  }, [id]);

  const submit = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/templates/${id}/judge`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...scores, reasoning: reasoning || null }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`Save failed: ${err.error ?? res.status}`);
        return;
      }
      setSavedAt(new Date().toLocaleTimeString());
    } finally { setSaving(false); }
  }, [id, scores, reasoning]);

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

  if (loading || !data) {
    return (
      <div className="p-12 text-center">
        <Loader2 className="w-6 h-6 animate-spin text-slate-400 mx-auto" />
      </div>
    );
  }

  const ai = data.ai_rating;

  return (
    <div className="max-w-3xl mx-auto p-6">
      <div className="mb-5">
        <h1 className="text-2xl font-semibold text-slate-900">人工评分</h1>
        <p className="text-sm text-slate-500 mt-1">
          按 6 个维度 1-10 打分. 跟 AI 评分横向比较, 累积出来的差异就是校准数据 — 我们以后用它来训练
          一个"听起来像人话"的打分模型.{" "}
          <Link href={`/templates/${id}/inspect`} className="text-blue-600">先看 inspect 渲染</Link>
          {" "}再回来打分.
        </p>
      </div>

      {ai && (
        <div className="mb-4 p-3 bg-purple-50 border border-purple-200 rounded text-xs">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-medium text-purple-900">AI ({ai.model_id ?? "?"}) 已评:</span>
            <span className="text-purple-700">{new Date(ai.updated_at).toLocaleString()}</span>
          </div>
          {ai.reasoning && <p className="text-purple-800 leading-relaxed">{ai.reasoning}</p>}
        </div>
      )}

      <div className="space-y-4 bg-white border border-slate-200 rounded-lg p-5">
        {DIMS.map((dim) => (
          <div key={dim.key} className="grid grid-cols-[180px_1fr_60px] items-center gap-3">
            <div>
              <div className="text-sm font-medium text-slate-900">{dim.label}</div>
              <div className="text-[11px] text-slate-500">{dim.help}</div>
              {ai && (
                <div className="text-[10px] text-purple-700 mt-0.5">
                  AI: {ai[dim.key]}/10
                </div>
              )}
            </div>
            <input
              type="range"
              min={1}
              max={10}
              step={1}
              value={scores[dim.key]}
              onChange={(e) => setScores((s) => ({ ...s, [dim.key]: Number(e.target.value) }))}
              className="w-full"
            />
            <div className="text-right">
              <span className="text-lg font-semibold text-slate-900">{scores[dim.key]}</span>
              <span className="text-xs text-slate-500">/10</span>
              {ai && Math.abs(scores[dim.key] - ai[dim.key]) >= 3 && (
                <div className="text-[10px] text-amber-700 mt-0.5">差 {Math.abs(scores[dim.key] - ai[dim.key])}</div>
              )}
            </div>
          </div>
        ))}

        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1">
            为什么这么打 (optional)
          </label>
          <textarea
            value={reasoning}
            onChange={(e) => setReasoning(e.target.value)}
            placeholder="例: AI 给 8 分但我觉得只有 4 分, 因为这段读起来还是太销售腔..."
            rows={4}
            className="w-full text-sm border border-slate-300 rounded px-2 py-1.5"
          />
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => void submit()}
            disabled={saving}
            className="px-4 py-2 bg-slate-900 text-white rounded text-sm hover:bg-slate-800 disabled:opacity-50"
          >
            {saving ? "Saving…" : data.my_rating ? "更新评分" : "保存评分"}
          </button>
          {savedAt && (
            <span className="inline-flex items-center gap-1 text-sm text-emerald-600">
              <Check className="w-4 h-4" /> 已保存 {savedAt}
            </span>
          )}
        </div>
      </div>

      {data.all_human_ratings.length > 1 && (
        <div className="mt-6">
          <h2 className="text-sm font-medium text-slate-700 mb-2">
            其他人的评分 ({data.all_human_ratings.length - (data.my_rating ? 1 : 0)})
          </h2>
          <div className="space-y-1">
            {data.all_human_ratings
              .filter((r) => r.rater_id !== data.my_rating?.rater_id)
              .map((r, i) => (
                <div key={i} className="text-xs text-slate-600 p-2 bg-slate-50 rounded">
                  rep #{r.rater_id}: P{r.politeness} C{r.clarity} R{r.peer_register} B{r.brand_fit} F{r.factual_accuracy} N{r.naturalness}
                  {r.reasoning && <div className="mt-1 text-slate-700">"{r.reasoning}"</div>}
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
