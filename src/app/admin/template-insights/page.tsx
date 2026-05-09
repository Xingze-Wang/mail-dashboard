"use client";

/**
 * /admin/template-insights
 *
 * Surfaces calibration data from template_ratings:
 *   - Top: per-dimension systematic bias (do humans + AI agree on
 *     average across dims, or does AI consistently over/under-rate?)
 *   - Bottom: per-template list sorted by |gap|, biggest disagreements
 *     first. Each row shows AI vs mean-human side-by-side per dim,
 *     plus a sample of each side's reasoning.
 *
 * Read-only. To rate a template, follow the row's link to
 * /templates/[id]/judge.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, AlertCircle, TrendingUp, TrendingDown } from "lucide-react";

const DIMS = [
  { key: "politeness",       label: "Polite" },
  { key: "clarity",          label: "Clarity" },
  { key: "peer_register",    label: "Peer reg" },
  { key: "brand_fit",        label: "Brand" },
  { key: "factual_accuracy", label: "Facts" },
  { key: "naturalness",      label: "Natural" },
] as const;
type Dim = typeof DIMS[number]["key"];

interface PerTemplate {
  template_id: string;
  template_name: string;
  template_status: string;
  template_segment: string | null;
  ai: Record<Dim, number> | null;
  human_mean: Record<Dim, number> | null;
  n_humans: number;
  gap: Record<Dim, number> | null;
  abs_gap_total: number;
  sample_human_reasoning: string | null;
  sample_ai_reasoning: string | null;
}

interface PerDimension {
  dimension: Dim;
  n_templates: number;
  ai_mean: number;
  human_mean: number;
  mean_gap: number;
}

interface InsightsResponse {
  perTemplate: PerTemplate[];
  perDimension: PerDimension[];
  totals: {
    n_templates_with_ratings: number;
    n_templates_paired: number;
    n_total_ratings: number;
  };
}

function fmt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(1);
}

function gapColor(g: number): string {
  const a = Math.abs(g);
  if (a < 1) return "text-slate-400";
  if (a < 2) return "text-amber-600";
  return "text-red-600";
}

export default function TemplateInsightsPage() {
  const [data, setData] = useState<InsightsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetch("/api/admin/template-insights", { credentials: "include" })
      .then(async (r) => {
        if (r.status === 403) { setAuthError(true); return; }
        if (!r.ok) {
          alert(`Load failed: ${r.status}`);
          return;
        }
        setData((await r.json()) as InsightsResponse);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

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

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900">Template scoring calibration</h1>
        <p className="text-sm text-slate-500 mt-1 leading-relaxed">
          AI 评分 vs 人工评分 在各维度上的差异. 系统性偏差 (AI 一致地对某个维度过高/过低评分) 是校准信号 —
          以后可以用累积的标注数据训练一个"听起来像不像人话"的打分模型.
          {" "}
          <span className="text-slate-600">
            {data.totals.n_templates_paired} 个模板有 AI + 人工双方评分 ·
            {" "}{data.totals.n_total_ratings} 总评分行
          </span>
        </p>
      </div>

      {/* Per-dimension systematic bias */}
      <div className="mb-8">
        <h2 className="text-base font-medium text-slate-800 mb-3">维度级别的系统性偏差</h2>
        <p className="text-xs text-slate-500 mb-3">
          Mean(human) − Mean(AI) per dimension. 正数 = humans rate higher than AI thinks
          (AI 低估了这个维度). 负数 = AI rates higher than humans agree
          (AI 高估了; 这是更需要警惕的方向, 意味着 AI 在自己的盲点上也很自信).
        </p>
        {data.perDimension.length === 0 || data.perDimension.every((d) => d.n_templates === 0) ? (
          <div className="bg-slate-50 border border-slate-200 rounded p-4 text-center text-sm text-slate-500">
            还没有人工评分数据. 去 <Link href="/templates" className="text-blue-600">/templates</Link> 选一个 proposal, 进 inspect, 再点 judge.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-separate border-spacing-y-1">
              <thead>
                <tr className="text-xs text-slate-500">
                  <th className="text-left p-2">Dimension</th>
                  <th className="text-right p-2">n templates</th>
                  <th className="text-right p-2">AI mean</th>
                  <th className="text-right p-2">Human mean</th>
                  <th className="text-right p-2">Mean gap</th>
                </tr>
              </thead>
              <tbody>
                {data.perDimension.map((d) => {
                  const trend = d.mean_gap > 0.5 ? "humans-higher" : d.mean_gap < -0.5 ? "ai-higher" : "agree";
                  return (
                    <tr key={d.dimension} className="bg-white border border-slate-200">
                      <td className="p-2 text-sm font-medium text-slate-900">{d.dimension}</td>
                      <td className="p-2 text-right text-xs text-slate-600">{d.n_templates}</td>
                      <td className="p-2 text-right text-sm">{fmt(d.ai_mean)}</td>
                      <td className="p-2 text-right text-sm">{fmt(d.human_mean)}</td>
                      <td className={`p-2 text-right text-sm font-medium ${gapColor(d.mean_gap)}`}>
                        {Number.isFinite(d.mean_gap) ? (d.mean_gap > 0 ? "+" : "") + d.mean_gap.toFixed(2) : "—"}
                        {trend === "ai-higher" && <TrendingUp className="inline w-3 h-3 ml-1 text-red-600" />}
                        {trend === "humans-higher" && <TrendingDown className="inline w-3 h-3 ml-1 text-amber-600" />}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Per-template detail */}
      <div>
        <h2 className="text-base font-medium text-slate-800 mb-3">
          Per-template, sorted by total |gap|
        </h2>
        {data.perTemplate.length === 0 ? (
          <div className="bg-slate-50 border border-slate-200 rounded p-4 text-center text-sm text-slate-500">
            没有 AI + 人工双评的模板.
          </div>
        ) : (
          <div className="space-y-3">
            {data.perTemplate.map((p) => (
              <Link
                key={p.template_id}
                href={`/templates/${p.template_id}/judge`}
                className="block bg-white border border-slate-200 rounded-lg p-4 hover:border-slate-400 transition"
              >
                <div className="flex items-baseline gap-2 mb-2">
                  <span className="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-slate-100 text-slate-700">
                    {p.template_status}
                  </span>
                  <span className="text-sm font-medium text-slate-900">{p.template_name}</span>
                  {p.template_segment && (
                    <span className="text-xs text-slate-500">seg={p.template_segment}</span>
                  )}
                  <span className="text-xs text-slate-500">· {p.n_humans} human{p.n_humans === 1 ? "" : "s"}</span>
                  <span className="ml-auto text-xs text-slate-600">
                    total |gap|: <span className={gapColor(p.abs_gap_total / 6)}>{p.abs_gap_total.toFixed(1)}</span>
                  </span>
                </div>

                <div className="grid grid-cols-6 gap-2">
                  {DIMS.map((dim) => {
                    const ai = p.ai?.[dim.key] ?? null;
                    const hm = p.human_mean?.[dim.key] ?? null;
                    const g = p.gap?.[dim.key] ?? 0;
                    return (
                      <div key={dim.key} className="text-center">
                        <div className="text-[10px] uppercase text-slate-500 tracking-wide mb-1">{dim.label}</div>
                        <div className="text-xs">
                          <span className="text-purple-700 font-mono">AI {fmt(ai)}</span>
                          <span className="text-slate-400"> · </span>
                          <span className="text-emerald-700 font-mono">H {fmt(hm)}</span>
                        </div>
                        <div className={`text-[10px] mt-0.5 font-medium ${gapColor(g)}`}>
                          {Number.isFinite(g) && g !== 0 ? (g > 0 ? "+" : "") + g.toFixed(1) : "—"}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {(p.sample_ai_reasoning || p.sample_human_reasoning) && (
                  <div className="mt-3 pt-3 border-t border-slate-100 grid grid-cols-2 gap-3">
                    {p.sample_ai_reasoning && (
                      <div className="text-xs">
                        <div className="text-purple-700 font-medium mb-0.5">AI:</div>
                        <p className="text-slate-700 line-clamp-2">{p.sample_ai_reasoning}</p>
                      </div>
                    )}
                    {p.sample_human_reasoning && (
                      <div className="text-xs">
                        <div className="text-emerald-700 font-medium mb-0.5">Human:</div>
                        <p className="text-slate-700 line-clamp-2">{p.sample_human_reasoning}</p>
                      </div>
                    )}
                  </div>
                )}
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
