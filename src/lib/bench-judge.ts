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
