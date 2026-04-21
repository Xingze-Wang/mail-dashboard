// Benchmark using the EXACT prompts resend0412.py runs in production —
// not toy approximations. Output text is persisted so the UI can show
// it, plus we score:
//   analyze: JSON validity + required fields + correct classification
//   intro:   format compliance (the very specific 三段论 rule)

import { llmChat, KNOWN_MODELS } from "@/lib/llm-proxy";
import { supabase } from "@/lib/db";
import { ALL_DIRECTIONS } from "@/lib/scanner-config";
import { judgeIntro, judgeAnalyze, type JudgeVerdict } from "@/lib/bench-judge";

// ───────────────────────── Sample papers + ground truth ─────────────────────────
//
// Each sample has expected classification — used to grade analyze output
// against ground truth, not just "did it produce JSON".

export const BENCH_SAMPLES = [
  {
    title: "4D Gaussian Splatting for Dynamic Scene Reconstruction",
    abstract:
      "We present 4D Gaussian Splatting (4DGS) that extends 3D Gaussians to the temporal dimension, enabling photorealistic novel-view synthesis of dynamic scenes from sparse monocular video. Our approach decomposes time into a temporal radiance field driven by anisotropic Gaussians; training takes 4 hours on 8 A100 GPUs.",
    authors: ["Xiang Li", "Yifan Wang", "Jianbo Jiao", "Andrew Markham"],
    emails: ["xli2024@cs.tsinghua.edu.cn", "y.wang@cs.tsinghua.edu.cn"],
    truth: {
      needs_compute: true,
      compute_level: "heavy",          // 8x A100 = clearly heavy
      research_direction: "3D Vision & Reconstruction",
      best_email_chinese: true,
      best_first_name_lowercase: "xiang", // xli2024 → Xiang Li
    },
  },
  {
    title: "FastInfer: A Distributed Inference Engine for 100B+ MoE Models",
    abstract:
      "FastInfer reduces MoE inference latency by co-locating experts and tokens via learned routing. Deployed on 256 H100s, 3.2× throughput vs vLLM on DeepSeek-V3.",
    authors: ["Zhihao Chen", "Mingyu Liu"],
    emails: ["chen.zhihao@stu.pku.edu.cn"],
    truth: {
      needs_compute: true,
      compute_level: "heavy",          // 256 H100s
      research_direction: "LLM Architecture & Efficiency",
      best_email_chinese: true,
      best_first_name_lowercase: "zhihao",
    },
  },
  {
    title: "A Survey of Tokenization Strategies for Multilingual NLP",
    abstract:
      "This survey reviews 60 tokenization methods for multilingual NLP, comparing BPE, SentencePiece, and character-level approaches across 30 languages. We propose a taxonomy and identify open research directions. No new models are trained; analysis uses published benchmark numbers.",
    authors: ["Maria Garcia", "John Smith"],
    emails: ["maria.garcia@stanford.edu"],
    truth: {
      needs_compute: false,            // survey, no training
      compute_level: "none",
      research_direction: "NLP & Text Processing",
      best_email_chinese: false,       // Maria Garcia is not Chinese
      best_first_name_lowercase: null,
    },
  },
];

// ───────────────────────── Real prompts (from resend0412.py) ─────────────────────────

function buildAnalyzePrompt(sample: typeof BENCH_SAMPLES[0]): string {
  const directionsStr = ALL_DIRECTIONS.join(", ");
  return `分析这篇论文，返回一个JSON对象。

标题: ${sample.title}
摘要: ${sample.abstract.slice(0, 800)}
作者: ${sample.authors.join(", ")}
邮箱: ${sample.emails.join(", ")}

请完成以下三个任务：

---

## 任务一：邮箱-作者匹配
根据邮箱前缀匹配作者（wzhang→Wei Zhang, zhangwei→Zhang Wei等）。
判断是否中国人：纯拼音名=中国人（Xinhao Wang），混合名=非中国人（David Chen）。
first_name是中文名的拼音（如Xinhao），用于邮件称呼。

---

## 任务二：算力需求判断
从以下六个维度综合分析，判断作者是否需要非平凡的算力支持（即普通笔记本无法完成）。

**方法论信号（强信号）**
- 训练/微调深度学习模型（training、fine-tuning、pre-training）
- 强化学习（RL、RLHF、PPO等）
- 神经架构搜索、超参数大规模搜索
- 蒙特卡洛/分子动力学/有限元/CFD等数值模拟

**模型规模信号（强信号）**
- 提及参数量级（billions、millions of parameters）
- LLM、foundation model、large-scale model
- 多模态、多任务联合训练
- scaling law、scaling up

**数据规模信号（中信号）**
- large-scale dataset、web-scale、internet-scale
- 大量图像/视频/基因组数据处理

**基础设施信号（强信号）**
- GPU、TPU、A100、H100、distributed training、HPC

**实验规模信号（中信号）**
- 大量ablation study、多数据集全面评估

**领域信号（弱信号）**
- 气候/天体模拟、蛋白质折叠、药物发现、自动驾驶感知

**负向信号（降低判断）**
- "training-free"、"without training"、"lightweight"、"efficient"（指资源高效）
- 纯理论推导、综述论文、无实验的框架提案
- 仅"使用"现有模型做推理，不涉及训练
- 小规模定性研究、数学证明类工作
- 体育预测、简单分类任务、小数据集实验

**判断原则：**
1. 关注动词：train/fine-tune/simulate/optimize=强信号；analyze/survey/propose（无实验）=弱信号
2. 区分"提出"和"使用"：仅调用GPT-4 API做实验 ≠ 需要算力
3. compute_level含义：
   - heavy：多卡GPU/HPC集群（大模型预训练、大规模仿真）→ confidence 0.85-1.0
   - moderate：单卡或少量GPU（中等模型微调、中规模实验）→ confidence 0.65-0.85
   - light：普通服务器可满足（小模型训练、小规模模拟）→ confidence 0.5-0.65
   - none：理论/综述/纯数学/小规模定性研究 → needs_compute=false, confidence 0.0-0.4

---

## 任务三：研究方向分类
将论文归入以下27个研究方向之一（选最匹配的1个）：
1.LLM Agents & Multi-Agent  2.LLM Reasoning & Planning  3.LLM Training & Post-training
4.LLM Architecture & Efficiency  5.LLM Safety & Alignment  6.VLM & Multimodal Understanding
7.Diffusion & Image/Video Generation  8.3D Vision & Reconstruction  9.Detection, Segmentation & Tracking
10.VLA & Robot Learning  11.Embodied AI & World Models  12.Autonomous Driving
13.Medical & Life Science AI  14.Science & Engineering AI  15.Remote Sensing & Geospatial
16.Audio, Speech & Music  17.NLP & Text Processing  18.RAG & Information Retrieval
19.Recommendation & Ranking  20.Code & Software Engineering  21.Reinforcement Learning
22.Time Series & Spatio-temporal  23.Graph & Network Learning  24.Privacy, Security & Federated
25.Representation & Transfer Learning  26.Benchmarks & Evaluation  27.Other
注意："safety"指训练稳定性=3不是5；RLHF/DPO训练LLM=3不是21；LLM持续学习=3不是25

## 任务四：Portfolio方向匹配
从列表中找出最相关的2-3个方向（必须完全匹配列表名称，无匹配则返回空列表）。
方向列表：${directionsStr}

---

只返回JSON，不要其他文字：
{
  "email_matches": [
    {"email": "xx@xx.edu", "author": "全名或null", "is_chinese": true/false, "first_name": "名或null"}
  ],
  "needs_compute": true/false,
  "compute_confidence": 0.0-1.0,
  "compute_level": "heavy/moderate/light/none",
  "compute_reason": "一句话原因，需引用摘要中的具体证据",
  "research_direction": "方向名称（从27个中选1个）",
  "matched_directions": ["方向1", "方向2"]
}`;
}

function buildIntroPrompt(sample: typeof BENCH_SAMPLES[0]): string {
  return `根据论文写一句个性化开头（1句话）。

标题: ${sample.title}
摘要: ${sample.abstract.slice(0, 1000)}

格式：最近在跟踪A方向的研究时，读到你的X paper，其中用Y方法（不要超过8个字）解决Z问题（9个字以内）的方案很有启发。如果能有更多算力支持，相信可以（提供更多insights，更大程度上验证方法的普适性等，这里可以看一下作者可能希望做到的事情，写一下如果有更多算力做到什么）。

**任何情况下，严禁出现""，*，//，%，$等任何符号**

注意：
1. A方向
- 这里需要找一个相对大一些的领域（e.g. Dyna网状Web agent架构 -> Web Agent方向研究）
- 第二个例子：Principle-Evolvable Scientific Discovery via Uncertainty Minimization -> AI4S相关
- 此外，要学会使用更加常用的表达（e.g. Offline Reinforcement Learning就说Offline RL，不要说离线强化学习）

错误例子：
- 最近在跟踪RAG查询优化研究 - 不像人话
- 推荐系统解释性 - 应该是推荐系统可解释性，人类不会说"解释性"这种词，而是"可解释性"

正确例子：
- 最近在整理可解释性领域的最新进展
- 最近在跟踪Agentic RL相关的研究
- 最近在跟踪持续学习方向的工作

2. X paper
- 如果论文标题是 xx: xxxx，那么用：前面的部分即可（e.g. RobustExplain: Evaluating Robustness... -> RobustExplain paper）
- 如果论文标题没有冒号，直接用《完整标题》
- 如果论文标题过长（超过10个英文单词），可以简化为"你的关于YYY的论文"

3. Y方法解决Z问题 - 不要超过12个字
- option a: 基于Y方法，解决Z问题
- option b: 解释了xx现象 / 深入分析了xx问题 / 揭示了xx机制

**注意：一定是三段论，每一个部分中间有逗号（最近在...，读到了...，其中）**

正确例子：
- 最近在跟踪持续学习方向的工作，读到了你的关于平衡模型稳定性和可塑性的论文，揭示了经验回放(ER)在不同任务上的二元性，很有启发。
- 最近在跟踪可解释性相关研究时，读到你的《Interpreting Emergent Extreme Events in Multi-Agent Systems》，其中用基于Shapley值进行多维度归因的方法解决解释multi-agent system涌现极端事件的方案很有启发。

只返回这一句话。`;
}

// ───────────────────────── Scorers (against ground truth) ─────────────────────────

function stripFences(s: string): string {
  let t = s.trim();
  if (t.startsWith("```")) {
    const i = t.indexOf("\n");
    t = t.slice(i + 1);
    if (t.endsWith("```")) t = t.slice(0, -3);
  }
  return t.trim();
}

interface AnalyzeScore {
  score: number;
  jsonValid: boolean;
  meta: {
    correctNeedsCompute?: boolean | null;
    correctLevel?: boolean | null;
    correctDirection?: boolean | null;
    correctChinese?: boolean | null;
    parsed?: Record<string, unknown>;
    missing?: string[];
    err?: string;
  };
}

function scoreAnalyze(text: string, truth: typeof BENCH_SAMPLES[0]["truth"]): AnalyzeScore {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(stripFences(text));
  } catch (e) {
    return { score: 0, jsonValid: false, meta: { err: e instanceof Error ? e.message.slice(0, 100) : "parse failed" } };
  }

  const required = ["email_matches", "needs_compute", "compute_level",
                    "compute_confidence", "compute_reason", "research_direction"];
  const missing = required.filter((k) => !(k in obj));
  if (missing.length) {
    return { score: 0.2, jsonValid: true, meta: { missing, parsed: obj } };
  }

  // Grade against ground truth (each fact = 0.25, plus 0 if JSON broken)
  const correctNeedsCompute = obj.needs_compute === truth.needs_compute;
  const correctLevel = obj.compute_level === truth.compute_level;
  const correctDirection = obj.research_direction === truth.research_direction;
  const emailMatches = (obj.email_matches as Array<{ is_chinese?: boolean }> | undefined) ?? [];
  const correctChinese = emailMatches.length > 0
    && emailMatches[0].is_chinese === truth.best_email_chinese;

  let score = 0;
  if (correctNeedsCompute) score += 0.25;
  if (correctLevel)        score += 0.25;
  if (correctDirection)    score += 0.30;
  if (correctChinese)      score += 0.20;

  return {
    score: Math.round(score * 100) / 100,
    jsonValid: true,
    meta: {
      correctNeedsCompute, correctLevel, correctDirection, correctChinese,
      parsed: {
        needs_compute: obj.needs_compute,
        compute_level: obj.compute_level,
        research_direction: obj.research_direction,
        is_chinese: emailMatches[0]?.is_chinese,
        compute_reason: String(obj.compute_reason ?? "").slice(0, 120),
      },
    },
  };
}

interface IntroScore {
  score: number;
  meta: {
    chars: number;
    chinese: boolean;
    threePart: boolean;     // matches "最近在...，读到了/到你...，其中..."
    noBannedSym: boolean;   // no " * // % $
    refsTitle: boolean;
    plausibleLength: boolean;
    preview: string;
  };
}

function scoreIntro(text: string, sample: typeof BENCH_SAMPLES[0]): IntroScore {
  const t = stripFences(text).trim();
  const chinese = /[\u4e00-\u9fff]/.test(t);
  const chars = [...t].length;

  // The prompt mandates 三段论: 最近在 X，读到 Y，其中 Z
  // Models drop the optional "了" and may add "时" before the comma; accept both.
  const threePart = /最近在[\s\S]{4,80}?[，,][\s\S]{0,40}?读到[\s\S]{4,80}?[，,][\s\S]+/.test(t);

  // Banned symbols (per prompt's strict rule)
  const noBannedSym = !/["*$%]|\/\//.test(t);

  // Reference paper title or a salient word
  const titleWords = sample.title.toLowerCase().split(/\s+/).filter((w) => w.length > 4);
  const refsTitle = titleWords.some((w) => t.toLowerCase().includes(w));

  // Plausible length 50-200 Chinese chars
  const plausibleLength = chars >= 50 && chars <= 200;

  let score = 0;
  if (chinese)         score += 0.15;
  if (threePart)       score += 0.35;  // structural correctness matters most
  if (noBannedSym)     score += 0.15;
  if (refsTitle)       score += 0.15;
  if (plausibleLength) score += 0.20;

  return {
    score: Math.round(score * 100) / 100,
    meta: { chars, chinese, threePart, noBannedSym, refsTitle, plausibleLength, preview: t.slice(0, 200) },
  };
}

// ───────────────────────── Per-model runner ─────────────────────────

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
  judges?: JudgeVerdict[];
  judgeAvg?: number | null;
  promptLeak?: boolean;
}

export async function benchOneModel(model: string, runId: string): Promise<BenchRow[]> {
  const rows: BenchRow[] = [];
  for (let i = 0; i < BENCH_SAMPLES.length; i++) {
    const s = BENCH_SAMPLES[i];

    // analyze
    try {
      const r = await llmChat({
        model,
        user: buildAnalyzePrompt(s),
        temperature: 0.1,
        max_tokens: 1500,
        json: true,
        timeoutMs: 60_000,
      });
      const sc = scoreAnalyze(r.text, s.truth);
      // Judge in parallel — 3 LLMs rate the output on specificity,
      // format, prompt-leak. Best-effort; failure is non-blocking.
      const verdicts = await judgeAnalyze(s.title, s.abstract, model, r.text);
      const judgeAvg = avgJudgeScores(verdicts);
      const anyLeak = verdicts.some((v) => v.prompt_leak);
      rows.push({
        model, task: "analyze", sampleIdx: i, score: sc.score,
        latency_s: r.meta.latency_s, tokens_in: r.meta.tokens_in,
        tokens_out: r.meta.tokens_out,
        output_text: JSON.stringify({ raw: r.text.slice(0, 2000), grade: sc.meta }),
        json_valid: sc.jsonValid, finish_reason: r.meta.finish_reason,
        provider: r.meta.provider, error: null,
        judges: verdicts, judgeAvg, promptLeak: anyLeak,
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
        model, user: buildIntroPrompt(s),
        temperature: 0.7, max_tokens: 800, timeoutMs: 60_000,
      });
      const sc = scoreIntro(r.text, s);
      const verdicts = await judgeIntro(s.title, s.abstract, model, r.text);
      const judgeAvg = avgJudgeScores(verdicts);
      const anyLeak = verdicts.some((v) => v.prompt_leak);
      rows.push({
        model, task: "intro", sampleIdx: i, score: sc.score,
        latency_s: r.meta.latency_s, tokens_in: r.meta.tokens_in,
        tokens_out: r.meta.tokens_out,
        output_text: JSON.stringify({ raw: r.text.slice(0, 2000), grade: sc.meta }),
        json_valid: null, finish_reason: r.meta.finish_reason,
        provider: r.meta.provider, error: null,
        judges: verdicts, judgeAvg, promptLeak: anyLeak,
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

  await supabase.from("model_bench_runs").insert(
    rows.map((r) => ({
      run_id: runId, model: r.model, task: r.task, sample_idx: r.sampleIdx,
      score: r.score, latency_s: r.latency_s, tokens_in: r.tokens_in,
      tokens_out: r.tokens_out, output_text: r.output_text, json_valid: r.json_valid,
      finish_reason: r.finish_reason, provider: r.provider, error: r.error,
      judges: r.judges ?? null,
      judge_avg: r.judgeAvg ?? null,
      prompt_leak: r.promptLeak ?? null,
    })),
  );
  return rows;
}

function avgJudgeScores(verdicts: JudgeVerdict[]): number | null {
  const good = verdicts.filter((v) => v.error === null);
  if (good.length === 0) return null;
  return Math.round(
    (good.reduce((a, v) => a + v.score_0_10, 0) / good.length) * 10,
  ) / 10;
}

export function listKnownModels(): string[] {
  return Object.keys(KNOWN_MODELS);
}
