// Real-task benchmarking: runs each candidate model on the two prompts
// resend0412.py uses (analyze + intro), scores the output, persists to DB.

import { llmChat, KNOWN_MODELS } from "@/lib/llm-proxy";
import { supabase } from "@/lib/db";

export const BENCH_SAMPLES = [
  {
    title: "4D Gaussian Splatting for Dynamic Scene Reconstruction",
    abstract:
      "We present 4D Gaussian Splatting (4DGS) that extends 3D Gaussians to the temporal dimension, enabling photorealistic novel-view synthesis of dynamic scenes from sparse monocular video. Training takes 4 hours on 8 A100 GPUs.",
    authors: ["Xiang Li", "Yifan Wang", "Jianbo Jiao"],
    candidate_email: "xli2024@cs.tsinghua.edu.cn",
  },
  {
    title: "FastInfer: A Distributed Inference Engine for 100B+ MoE Models",
    abstract:
      "FastInfer reduces MoE inference latency by co-locating experts and tokens via learned routing. Deployed on 256 H100s, 3.2× throughput vs vLLM on DeepSeek-V3.",
    authors: ["Zhihao Chen", "Mingyu Liu"],
    candidate_email: "chen.zhihao@stu.pku.edu.cn",
  },
  {
    title: "Token-Level Reinforcement Learning for Aligning LLMs",
    abstract:
      "Token-RL applies PPO at the token level rather than response level for RLHF. Matches DPO with 30% fewer GPU hours on a 70B Llama-3 base.",
    authors: ["Sarah Brown", "Wei Zhang"],
    candidate_email: "sarah.brown@stanford.edu",
  },
];

const ANALYZE_SYSTEM = "你是一个判断 AI 论文是否需要 GPU 算力支持的专家。只返回 JSON。";
const ANALYZE_PROMPT = (s: typeof BENCH_SAMPLES[0]) =>
  `根据论文判断是否值得给作者推送免费算力邀请。
标题: ${s.title}
摘要: ${s.abstract}
作者: ${s.authors.join(", ")}
邮箱候选: ${s.candidate_email}

只返回 JSON：
{
  "needs_compute": true/false,
  "compute_level": "heavy"/"moderate"/"light"/"none",
  "compute_confidence": 0.0-1.0,
  "compute_reason": "一句话原因",
  "is_chinese_author": true/false,
  "best_email": "中国一作邮箱 or null"
}`;

const INTRO_SYSTEM = "你是一名销售，针对 AI 论文作者写一句中文个性化开场白。";
const INTRO_PROMPT = (s: typeof BENCH_SAMPLES[0]) =>
  `根据论文写一句个性化的中文开场白（1 句话，30-50 字），引用具体技术细节。
标题: ${s.title}
摘要: ${s.abstract}

只返回这一句话。`;

// ────────── Scorers (same heuristic as the Python bench) ──────────

function scoreAnalyze(text: string): { score: number; jsonValid: boolean; meta: Record<string, unknown> } {
  let clean = text.trim();
  if (clean.startsWith("```")) {
    const i = clean.indexOf("\n");
    clean = clean.slice(i + 1);
    if (clean.endsWith("```")) clean = clean.slice(0, -3);
  }
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(clean);
  } catch {
    return { score: 0, jsonValid: false, meta: { err: "invalid JSON" } };
  }

  const required = ["needs_compute", "compute_level", "compute_confidence",
    "compute_reason", "is_chinese_author", "best_email"];
  const missing = required.filter((k) => !(k in obj));
  if (missing.length) {
    return { score: 0.3, jsonValid: true, meta: { missing } };
  }

  let s = 1.0;
  if (typeof obj.needs_compute !== "boolean") s -= 0.15;
  if (!["heavy", "moderate", "light", "none"].includes(String(obj.compute_level))) s -= 0.15;
  const c = Number(obj.compute_confidence);
  if (isNaN(c) || c < 0 || c > 1) s -= 0.15;
  if (typeof obj.compute_reason !== "string" || obj.compute_reason.length < 10) s -= 0.15;
  return {
    score: Math.max(0, Math.round(s * 100) / 100),
    jsonValid: true,
    meta: { needs_compute: obj.needs_compute, level: obj.compute_level, conf: obj.compute_confidence },
  };
}

function scoreIntro(text: string, title: string): { score: number; meta: Record<string, unknown> } {
  const t = text.trim();
  const hasChinese = /[\u4e00-\u9fff]/.test(t);
  const chars = [...t].length;
  const oneSentence = (t.split("。").length - 1) <= 2 && !t.includes("\n\n");
  const titleWords = title.toLowerCase().split(/\s+/).filter((w) => w.length > 4);
  const refsPaper = titleWords.some((w) => t.toLowerCase().includes(w));
  let s = 0;
  if (hasChinese) s += 0.4;
  if (chars >= 20 && chars <= 80) s += 0.3;
  if (oneSentence) s += 0.15;
  if (refsPaper) s += 0.15;
  return {
    score: Math.round(s * 100) / 100,
    meta: { chars, hasChinese, oneSentence, refsPaper, preview: t.slice(0, 90) },
  };
}

// ────────── Run a single model end-to-end ──────────

export interface BenchRow {
  model: string;
  task: "analyze" | "intro";
  sampleIdx: number;
  score: number;
  latency_s: number;
  tokens_in: number | null;
  tokens_out: number | null;
  output_text: string;
  json_valid: boolean | null;
  finish_reason: string | null;
  provider: string | null;
  error: string | null;
}

export async function benchOneModel(model: string, runId: string): Promise<BenchRow[]> {
  const rows: BenchRow[] = [];
  for (let i = 0; i < BENCH_SAMPLES.length; i++) {
    const s = BENCH_SAMPLES[i];
    // analyze
    try {
      const r = await llmChat({
        model, system: ANALYZE_SYSTEM, user: ANALYZE_PROMPT(s),
        temperature: 0.1, max_tokens: 400, json: true, timeoutMs: 45_000,
      });
      const sc = scoreAnalyze(r.text);
      rows.push({
        model, task: "analyze", sampleIdx: i, score: sc.score,
        latency_s: r.meta.latency_s, tokens_in: r.meta.tokens_in,
        tokens_out: r.meta.tokens_out, output_text: r.text.slice(0, 1500),
        json_valid: sc.jsonValid, finish_reason: r.meta.finish_reason,
        provider: r.meta.provider, error: null,
      });
    } catch (e) {
      rows.push({
        model, task: "analyze", sampleIdx: i, score: 0,
        latency_s: 0, tokens_in: null, tokens_out: null, output_text: "",
        json_valid: false, finish_reason: null, provider: null,
        error: e instanceof Error ? e.message.slice(0, 300) : String(e),
      });
    }
    // intro
    try {
      const r = await llmChat({
        model, system: INTRO_SYSTEM, user: INTRO_PROMPT(s),
        temperature: 0.7, max_tokens: 200, timeoutMs: 45_000,
      });
      const sc = scoreIntro(r.text, s.title);
      rows.push({
        model, task: "intro", sampleIdx: i, score: sc.score,
        latency_s: r.meta.latency_s, tokens_in: r.meta.tokens_in,
        tokens_out: r.meta.tokens_out, output_text: r.text.slice(0, 1500),
        json_valid: null, finish_reason: r.meta.finish_reason,
        provider: r.meta.provider, error: null,
      });
    } catch (e) {
      rows.push({
        model, task: "intro", sampleIdx: i, score: 0,
        latency_s: 0, tokens_in: null, tokens_out: null, output_text: "",
        json_valid: null, finish_reason: null, provider: null,
        error: e instanceof Error ? e.message.slice(0, 300) : String(e),
      });
    }
  }

  // Persist
  const dbRows = rows.map((r) => ({
    run_id: runId,
    model: r.model,
    task: r.task,
    sample_idx: r.sampleIdx,
    score: r.score,
    latency_s: r.latency_s,
    tokens_in: r.tokens_in,
    tokens_out: r.tokens_out,
    output_text: r.output_text,
    json_valid: r.json_valid,
    finish_reason: r.finish_reason,
    provider: r.provider,
    error: r.error,
  }));
  await supabase.from("model_bench_runs").insert(dbRows);
  return rows;
}

export function listKnownModels(): string[] {
  return Object.keys(KNOWN_MODELS);
}
