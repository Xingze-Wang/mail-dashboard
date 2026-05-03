// Congress bench: run the same deliberation prompt across models and score
// the quality of their panel output. Extends the same bench infrastructure
// (model_bench_runs table, llmChat proxy) with a new task type "congress".
//
// Scoring criteria (all between 0-1):
//   - JSON valid + has `personas` key         0.20
//   - All 5 expected personas present          0.30
//   - Adversary present                        0.10
//   - Synthesizer present + > 60 chars        0.20
//   - Proposal title present                  0.10
//   - No blank personas (all > 20 chars)      0.10

import { llmChat } from "@/lib/llm-proxy";
import { supabase } from "@/lib/db";

// Sample evidence packs — represent realistic congress inputs.
export const CONGRESS_SAMPLES = [
  {
    id: "bench_001",
    title: "Subject line A/B: question vs. statement",
    evidence: `
Evidence pack:
- Sent 240 emails in the last 14 days: 120 with question subject lines ("Are you scaling your training cluster?"), 120 with statement subjects ("We support large-scale GPU clusters for ML research").
- Open rate: question 34.2% vs. statement 28.7% (+5.5pp).
- Reply rate: question 4.2% vs. statement 5.1% (+0.9pp for statement).
- Click rate: question 2.1% vs. statement 1.8%.
- Recipients: cs.LG, cs.AI, cs.CV; 68% Chinese institutions; Tier 1 and Tier 2 split 40/60.
- Current global template uses statement-style subjects.
Baseline click rate: 1.95% (90d rolling).
Sample size per arm: 120. Significance threshold: 80 sends per arm.
`.trim(),
  },
  {
    id: "bench_002",
    title: "Routing tweak: deprioritize Tier 3 leads for Leo",
    evidence: `
Evidence pack:
- Leo has 87 Tier 3 leads assigned in the last 30 days; wechat conversion rate: 0.8%.
- Leo has 34 Tier 1 leads assigned; wechat conversion rate: 8.2%.
- Team average Tier 3 wechat rate: 1.4%.
- Leo's total wechat conversions this month: 12 (4 from Tier 3, 8 from Tier 1/2).
- Proposed change: cap Leo's Tier 3 assignments at 20% of his weekly batch; redirect excess to Ethan.
- Ethan's Tier 3 wechat rate: 2.1%.
- Risk: Ethan is already at 90% capacity (28/31 assigned leads responded to).
`.trim(),
  },
];

// The congress deliberation prompt. This matches what Loop 2 (weekly) runs.
function buildCongressPrompt(sample: typeof CONGRESS_SAMPLES[0]): string {
  return `你是一个销售邮件策略委员会的主持人。以下是一个战术提案的证据包，请组织一场委员会讨论并给出建议。

## 提案标题
${sample.title}

## 证据
${sample.evidence}

## 委员会成员
请以以下每个角色的身份发言（每个角色1-3句），然后让adversary提出最有力的反对意见，最后由synthesizer给出综合建议。

角色：
- data_analyst：从数据出发，评估置信度和样本量是否足够
- copywriter：从邮件写作角度评估影响
- academic_proxy：代表目标受众（学术科研人员）的视角
- sales_director：从销售目标和资源分配角度
- psychologist：从收件人心理和行为动机角度
- adversary：提出最强烈的反对意见或风险
- synthesizer：综合所有意见，给出最终建议（approve/reject/defer + 理由）

只返回JSON：
{
  "title": "${sample.title}",
  "personas": {
    "data_analyst": "...",
    "copywriter": "...",
    "academic_proxy": "...",
    "sales_director": "...",
    "psychologist": "...",
    "adversary": "...",
    "synthesizer": "..."
  },
  "recommendation": "approve" | "reject" | "defer",
  "confidence": 0.0-1.0
}`;
}

const REQUIRED_PERSONAS = ["data_analyst", "copywriter", "academic_proxy", "sales_director", "psychologist"];

export interface CongressScore {
  score: number;
  jsonValid: boolean;
  meta: {
    personasPresent: string[];
    adversaryPresent: boolean;
    synthesizerOk: boolean;
    titlePresent: boolean;
    noBlanks: boolean;
    recommendation?: string;
    confidence?: number;
    err?: string;
  };
}

function stripFences(s: string): string {
  let t = s.trim();
  if (t.startsWith("```")) {
    const i = t.indexOf("\n");
    t = t.slice(i + 1);
    if (t.endsWith("```")) t = t.slice(0, -3);
  }
  return t.trim();
}

function scoreCongress(text: string, sample: typeof CONGRESS_SAMPLES[0]): CongressScore {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(stripFences(text));
  } catch (e) {
    return { score: 0, jsonValid: false, meta: { personasPresent: [], adversaryPresent: false, synthesizerOk: false, titlePresent: false, noBlanks: false, err: e instanceof Error ? e.message.slice(0, 80) : "parse failed" } };
  }

  const personas = (obj.personas ?? {}) as Record<string, string>;

  const personasPresent = REQUIRED_PERSONAS.filter((p) => typeof personas[p] === "string" && personas[p].length > 0);
  const adversaryPresent = typeof personas.adversary === "string" && personas.adversary.length > 10;
  const synthesizerOk = typeof personas.synthesizer === "string" && personas.synthesizer.length > 60;
  const titlePresent = typeof obj.title === "string" && obj.title.length > 0;
  const noBlanks = personasPresent.every((p) => (personas[p] ?? "").length > 20);

  let score = 0;
  score += 0.20; // JSON valid
  score += (personasPresent.length / REQUIRED_PERSONAS.length) * 0.30;
  if (adversaryPresent) score += 0.10;
  if (synthesizerOk)    score += 0.20;
  if (titlePresent)     score += 0.10;
  if (noBlanks)         score += 0.10;

  return {
    score: Math.round(score * 100) / 100,
    jsonValid: true,
    meta: {
      personasPresent,
      adversaryPresent,
      synthesizerOk,
      titlePresent,
      noBlanks,
      recommendation: typeof obj.recommendation === "string" ? obj.recommendation : undefined,
      confidence: typeof obj.confidence === "number" ? obj.confidence : undefined,
    },
  };
}

export interface CongressBenchRow {
  model: string;
  task: "congress";
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

export async function benchCongressOneModel(model: string, runId: string): Promise<CongressBenchRow[]> {
  const rows: CongressBenchRow[] = [];

  for (let i = 0; i < CONGRESS_SAMPLES.length; i++) {
    const s = CONGRESS_SAMPLES[i];
    try {
      const r = await llmChat({
        model,
        user: buildCongressPrompt(s),
        temperature: 0.4,
        max_tokens: 2000,
        json: true,
        timeoutMs: 90_000,
      });
      const sc = scoreCongress(r.text, s);
      rows.push({
        model, task: "congress", sampleIdx: i, score: sc.score,
        latency_s: r.meta.latency_s, tokens_in: r.meta.tokens_in,
        tokens_out: r.meta.tokens_out,
        output_text: JSON.stringify({ raw: r.text.slice(0, 3000), grade: sc.meta }),
        json_valid: sc.jsonValid, finish_reason: r.meta.finish_reason,
        provider: r.meta.provider, error: null,
      });
    } catch (e) {
      rows.push({
        model, task: "congress", sampleIdx: i, score: 0,
        latency_s: 0, tokens_in: null, tokens_out: null, output_text: "",
        json_valid: false, finish_reason: null, provider: null,
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
      judges: null, judge_avg: null, prompt_leak: null,
    })),
  );

  return rows;
}
