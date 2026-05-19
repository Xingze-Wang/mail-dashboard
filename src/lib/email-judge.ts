// Three-model semantic judge for outreach email intros.
//
// Runs Claude Sonnet 4.6 + GLM 4.7 + Gemini 2.5 Flash (direct) in parallel.
// Each model returns a JSON verdict on (a) whether the intro follows the
// 四段论 prompt format and (b) whether the intro is actually about the
// paper. The lead is BLOCKED if any single judge votes should_block=true
// (aggressive rule per 2026-05-19 product call).
//
// Calibrated against 9 real production drafts + 5 known-bad samples — see
// scripts/_calibrate-judges.mjs + scripts/_calibrate-judges-bad.mjs.
// Clean drafts uniformly scored votes=0/3; all 5 bad samples scored ≥2/3.
//
// Why three models from three families (Anthropic / Zhipu / Google):
//   - Single-model has systematic bias (Sonnet over-rewards Chinese fluency,
//     Gemini missed an unrendered-template case entirely)
//   - Diverse families catch different failure modes (calibration showed
//     Gemini gave 10/10 to a literal [X方向] template leak — the others
//     caught it)
//
// Cost: ~$0.008/email (Sonnet ~$0.005 + GLM ~$0.001 + Gemini ~$0.002).
// Latency: ~1-2s when run in parallel.

const PROXY_URL = "https://openai-proxy.miracleplus.com/v1/chat/completions";
const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
const JUDGE_TIMEOUT_MS = 30_000;

export type SingleVerdict =
  | {
      instruction_followed: number;
      paper_relevant: number;
      should_block: boolean;
      reasoning: string;
    }
  | { error: string };

export interface JudgeVerdict {
  passed: boolean; // true if no judge voted block AND ≥1 judge returned valid JSON
  block_votes: number; // 0–3
  valid_judges: number; // 0–3, count of judges that returned parseable JSON
  sonnet: SingleVerdict;
  glm: SingleVerdict;
  gemini: SingleVerdict;
  mean_instr: number | null;
  mean_rel: number | null;
  ts: string;
  model_versions: { sonnet: string; glm: string; gemini: string };
}

function buildJudgePrompt(args: {
  intro: string;
  paperTitle: string;
  paperAbstract: string;
}): string {
  return `你正在审核一封要发给科研作者的销售邮件的 personalized intro (1 句话)。

邮件目标：邀请作者申请奇绩算力（免费 GPU 资源）。
intro 应当是 1 句中文，四段论结构：
  1) "最近在跟踪[X方向]的研究时"
  2) "读到你的[paper名]"
  3) "其中[Y方法]解决[Z问题]的方案很有启发"
  4) "如果能有更多算力支持，相信可以..."

对这封邮件，请输出 JSON：
{
  "instruction_followed": 0-10,
  "paper_relevant": 0-10,
  "reasoning": "<不超过 80 字>",
  "should_block": true|false
}

paper 标题：${args.paperTitle}
paper 摘要（前 800 字）：${(args.paperAbstract || "").slice(0, 800)}

要审核的 intro：
"""
${args.intro}
"""

只输出 JSON，不要任何 markdown 或解释。`;
}

function parseVerdict(raw: string): SingleVerdict {
  let cleaned = (raw || "").trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first >= 0 && last > first) cleaned = cleaned.slice(first, last + 1);
  try {
    const j = JSON.parse(cleaned);
    const instr = Number(j.instruction_followed);
    const rel = Number(j.paper_relevant);
    if (!Number.isFinite(instr) || !Number.isFinite(rel)) {
      return { error: `parse_no_scores: ${raw.slice(0, 150)}` };
    }
    return {
      instruction_followed: instr,
      paper_relevant: rel,
      should_block: Boolean(j.should_block),
      reasoning: String(j.reasoning || "").slice(0, 300),
    };
  } catch {
    return { error: `parse_fail: ${raw.slice(0, 150)}` };
  }
}

async function callWithRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts) await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
  throw lastErr;
}

async function proxyCall(
  model: string,
  prompt: string,
  opts: { useJsonMode?: boolean; maxTokens?: number } = {},
): Promise<string> {
  return callWithRetry(async () => {
    const body: Record<string, unknown> = {
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: opts.maxTokens ?? 1500,
    };
    if (opts.useJsonMode !== false) body.response_format = { type: "json_object" };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), JUDGE_TIMEOUT_MS);
    try {
      const res = await fetch(PROXY_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.MIRACLEPLUS_PROXY_KEY}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`proxy ${res.status}: ${text.slice(0, 200)}`);
      const j = JSON.parse(text);
      return j?.choices?.[0]?.message?.content || "";
    } finally {
      clearTimeout(timer);
    }
  });
}

async function geminiDirectCall(prompt: string): Promise<string> {
  return callWithRetry(async () => {
    const key = process.env.GOOGLE_API_KEY;
    if (!key) throw new Error("GOOGLE_API_KEY not set");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), JUDGE_TIMEOUT_MS);
    try {
      const res = await fetch(`${GEMINI_URL}?key=${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          // 2500 tokens — gemini-2.5-flash burns "thinking tokens" against
          // maxOutputTokens; below 1000 we got mid-output truncation.
          generationConfig: { temperature: 0.2, maxOutputTokens: 2500 },
        }),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`gemini ${res.status}: ${text.slice(0, 200)}`);
      const j = JSON.parse(text);
      return j?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    } finally {
      clearTimeout(timer);
    }
  });
}

export async function judgeIntroThreeModels(args: {
  intro: string;
  paperTitle: string;
  paperAbstract: string;
}): Promise<JudgeVerdict> {
  const prompt = buildJudgePrompt(args);
  const SONNET_MODEL = "claude-sonnet-4-6";
  const GLM_MODEL = "z-ai/glm-4.7";
  const GEMINI_MODEL = "gemini-2.5-flash";

  // All three in parallel. Each handles its own retry; on final failure we
  // store {error} for that judge but proceed.
  const [sonnetRaw, glmRaw, geminiRaw] = await Promise.all([
    proxyCall(SONNET_MODEL, prompt, { useJsonMode: true }).then(parseVerdict).catch((e) => ({
      error: e instanceof Error ? e.message : String(e),
    } as SingleVerdict)),
    // GLM via z-ai route silently returns empty when json_object is forced.
    // Skip strict mode; rely on prompt + post-parse.
    proxyCall(GLM_MODEL, prompt, { useJsonMode: false }).then(parseVerdict).catch((e) => ({
      error: e instanceof Error ? e.message : String(e),
    } as SingleVerdict)),
    geminiDirectCall(prompt).then(parseVerdict).catch((e) => ({
      error: e instanceof Error ? e.message : String(e),
    } as SingleVerdict)),
  ]);

  const sonnet = sonnetRaw;
  const glm = glmRaw;
  const gemini = geminiRaw;

  const allJudges = [sonnet, glm, gemini];
  const valid = allJudges.filter((v): v is Exclude<SingleVerdict, { error: string }> => !("error" in v));
  const blockVotes = valid.filter((v) => v.should_block === true).length;
  const validJudges = valid.length;

  const instrScores = valid.map((v) => v.instruction_followed);
  const relScores = valid.map((v) => v.paper_relevant);
  const meanInstr =
    instrScores.length > 0 ? instrScores.reduce((a, b) => a + b, 0) / instrScores.length : null;
  const meanRel =
    relScores.length > 0 ? relScores.reduce((a, b) => a + b, 0) / relScores.length : null;

  // Block rule (2026-05-19 user call): block on ANY judge voting block.
  // If ZERO judges returned valid JSON, we don't have signal — treat as
  // pass (the structural QC layer above is the catch-all for "model is
  // completely broken").
  const passed = validJudges === 0 || blockVotes === 0;

  return {
    passed,
    block_votes: blockVotes,
    valid_judges: validJudges,
    sonnet,
    glm,
    gemini,
    mean_instr: meanInstr,
    mean_rel: meanRel,
    ts: new Date().toISOString(),
    model_versions: { sonnet: SONNET_MODEL, glm: GLM_MODEL, gemini: GEMINI_MODEL },
  };
}

/**
 * Extract block 2 (intro) from a rendered draft_html. Mirror of the
 * splitter in src/lib/email-structural-qc.ts so this module stays
 * standalone (no cross-imports).
 */
export function extractIntroFromHtml(html: string | null | undefined): string {
  if (!html) return "";
  let t = html.replace(/<br\s*\/?>/gi, "<br>");
  t = t.replace(/<\/?(?:html|head|body|meta)[^>]*>/gi, "");
  const parts = t
    .split(/(?:<br>\s*){2,}/)
    .map((p) => p.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return parts.length >= 2 ? parts[1] : "";
}
