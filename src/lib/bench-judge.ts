// LLM-as-judge scoring. Given a model's output, ask multiple judges
// (Opus, Gemini 3 Pro, GPT-5) to score it independently on the axes
// that the regex scorer can't see — human-likeness, specificity,
// prompt-adherence.
//
// Cheaper + more honest than trying to encode taste in code.

import { llmChat } from "@/lib/llm-proxy";
import { getConfig } from "@/lib/system-config";

export const JUDGE_MODELS = ["claude-opus-4.7", "gemini-3-pro", "gpt-5"] as const;

export interface JudgeVerdict {
  judge: string;
  score_0_10: number;
  reasons: string;
  prompt_leak: boolean;  // true if placeholders, AI self-refs, or system-prompt echo detected
  raw: string;
  error: string | null;
}

export const DEFAULT_INTRO_RUBRIC = `你在评价一封 B2B 销售邮件的开头句（中文）。打分 0-10：
- 10 = 真人写的，引用论文里具体细节，自然不套路
- 7  = 合格，结构对，细节泛泛
- 4  = 套路话，任意论文都能用
- 0  = 离题 / 格式错 / 乱码 / 泄漏 prompt 或 AI 自述

给分时重点看：
1. 具体性（引了论文里的具体技术/数字/场景 vs 空话）
2. 自然度（像真人写的 vs AI 味的堆砌词）
3. 三段论格式（最近在 X，读到 Y，其中 Z...）
4. 避开明显 AI tell（"非常令人印象深刻"、"令人惊叹"、"的方案的方案"、冗余修饰）
5. **prompt 泄漏检查**：
   - 是否出现未替换的占位符（{{REP_NAME}}、{{REP_WECHAT}}）？
   - 是否说"作为 AI/作为 Claude/作为 Gemini"？
   - 是否把 system prompt 内容泄出来（"我是一名销售"、"你让我写"）？
   任一出现 → 直接扣到 0-2 分`;

const ANALYZE_RUBRIC = `你在评价一个论文-算力需求判断器的输出。打分 0-10：
- 10 = JSON 格式正确、字段完整、分类准确、理由引用摘要具体证据
- 7  = 分类对但理由模糊 / 字段少一个
- 4  = 分类错一个维度
- 0  = JSON 坏 / 乱猜`;

const RESPONSE_SCHEMA = `{"score": 0-10, "reasons": "一句话点评", "prompt_leak": true/false}`;

export async function judgeIntro(
  paperTitle: string,
  paperAbstract: string,
  modelName: string,
  output: string,
): Promise<JudgeVerdict[]> {
  // Pull admin-edited rubric from system_config; fall back to hardcoded default.
  // Caching is not worth it — one DB round-trip per batch, not per verdict.
  const stored = await getConfig<{ intro_rubric?: string }>("active_rubric");
  const rubric = stored?.intro_rubric?.trim() || DEFAULT_INTRO_RUBRIC;
  return judgeAll(
    rubric,
    `论文标题: ${paperTitle}\n论文摘要: ${paperAbstract}\n\n被评价模型: ${modelName}\n被评价输出:\n${output}\n\n只返回 JSON: ${RESPONSE_SCHEMA}`,
  );
}

export async function judgeAnalyze(
  paperTitle: string,
  paperAbstract: string,
  modelName: string,
  output: string,
): Promise<JudgeVerdict[]> {
  return judgeAll(
    ANALYZE_RUBRIC,
    `论文标题: ${paperTitle}\n论文摘要: ${paperAbstract}\n\n被评价模型: ${modelName}\n被评价输出:\n${output}\n\n只返回 JSON: ${RESPONSE_SCHEMA}`,
  );
}

/**
 * judgePrediction — score the *reasoning quality* of a helper
 * prediction after its outcome resolved. Distinct from outcome
 * (already known: correct/wrong); this asks "was the reasoning
 * sound, given what actually happened?"
 *
 * The 4 cases the helper learns from:
 *   wrong outcome + low judge  → strong critique (lazy reasoning + missed)
 *   wrong outcome + high judge → soft critique (world surprised us)
 *   right outcome + low judge  → "right by accident, lower confidence"
 *   right outcome + high judge → no critique, validated reasoning
 */
const PREDICTION_RUBRIC = `你在评价一个 sales helper 对 lead 的预测的**思考质量** (不是结果对错 — 结果你已经知道了, 给在 user message 里).
关键: 判断 reasoning 本身是否合理, 而不是结果碰巧对不对.

打分 0-10:
- 10 = 推理紧扣 lead 的具体细节 (paper / school / direction / 历史互动), 因果链合理, 即使结果错了也能学到东西
- 7  = 推理用到了一些 lead context, 但部分论据偏 generic
- 4  = 推理是套话, 任何 lead 都能套, 没有具体证据支持
- 0  = 没有推理 / 自相矛盾 / 跟 lead 无关 / 结果对纯属碰巧

重点看:
1. 是否引用了 lead 的具体特征 (paper 主题 / school tier / 是否 industry / 之前互动)
2. 因果链是否合理 (X 因为 Y 所以 Z, 不是直接断言)
3. 是否考虑了反例 / 边界情况
4. 即使预测对了, 推理是不是恰好猜中而已`;

export async function judgePrediction(input: {
  claim: string;
  targetEvent: string;
  outcomeNote: string;
  outcomeCorrect: boolean;
  leadContext?: {
    title: string | null;
    abstract?: string | null;
    schoolName?: string | null;
    schoolTier?: number | null;
    authorEmail?: string | null;
  } | null;
}): Promise<JudgeVerdict[]> {
  const lead = input.leadContext;
  const ctx = lead
    ? `参考 lead 信息:
title: ${lead.title ?? "?"}
school: ${lead.schoolName ?? "?"} (tier ${lead.schoolTier ?? "?"})
author email: ${lead.authorEmail ?? "?"}
${lead.abstract ? `abstract 前 600 字: ${lead.abstract.slice(0, 600)}` : ""}
`
    : "(没有具体的 lead 上下文 — 只能就 claim 本身的 reasoning 质量打分)";

  const user = `Helper 的预测 claim:
"${input.claim}"

预测的 target event: ${input.targetEvent}
deadline 到了之后实际发生了什么: ${input.outcomeNote}
所以预测的**结果**: ${input.outcomeCorrect ? "对" : "错"}

${ctx}

只返回 JSON: ${RESPONSE_SCHEMA}
注意: 你不是在评价**结果**对错 (那已经知道了), 而是评价**推理质量** — 即使结果错了, 推理也可能是好的; 即使结果对了, 推理也可能很草率.`;

  return judgeAll(PREDICTION_RUBRIC, user);
}

async function judgeAll(system: string, user: string): Promise<JudgeVerdict[]> {
  const results = await Promise.allSettled(
    JUDGE_MODELS.map(async (judge) => {
      try {
        const r = await llmChat({
          model: judge,
          system,
          user,
          temperature: 0.1,
          max_tokens: 500,
          json: true,
          timeoutMs: 40_000,
        });
        const raw = r.text;
        const parsed = parseVerdict(raw);
        return {
          judge,
          score_0_10: parsed.score,
          reasons: parsed.reasons,
          prompt_leak: parsed.prompt_leak,
          raw,
          error: null,
        } as JudgeVerdict;
      } catch (e) {
        return {
          judge,
          score_0_10: 0,
          reasons: "",
          prompt_leak: false,
          raw: "",
          error: e instanceof Error ? e.message.slice(0, 200) : String(e),
        } as JudgeVerdict;
      }
    }),
  );

  return results.map((r) =>
    r.status === "fulfilled"
      ? r.value
      : { judge: "?", score_0_10: 0, reasons: "", prompt_leak: false, raw: "", error: "settle error" },
  );
}

function parseVerdict(raw: string): { score: number; reasons: string; prompt_leak: boolean } {
  let clean = raw.trim();
  if (clean.startsWith("```")) {
    const i = clean.indexOf("\n");
    clean = clean.slice(i + 1);
    if (clean.endsWith("```")) clean = clean.slice(0, -3);
  }
  try {
    const obj = JSON.parse(clean);
    const s = Number(obj.score);
    return {
      score: isNaN(s) ? 0 : Math.max(0, Math.min(10, s)),
      reasons: String(obj.reasons ?? "").slice(0, 400),
      prompt_leak: obj.prompt_leak === true,
    };
  } catch {
    // Fallback: regex extract first number 0-10
    const m = raw.match(/\b([0-9]|10)\b/);
    return { score: m ? Number(m[1]) : 0, reasons: raw.slice(0, 200), prompt_leak: false };
  }
}
