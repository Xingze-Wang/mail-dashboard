#!/usr/bin/env node
// Sanity-check: feed the 3-model judge a few KNOWN-BAD intros (CoT leak,
// Gemini error string, fake paper) to confirm judges actually flag them.
// If judges return 9/9 for these, the scoring is useless — we need a
// harder prompt or a different model mix.

const BAD_SAMPLES = [
  {
    label: "gemini_api_error",
    intro: "Gemini 3 Pro is no longer available. Please switch to Gemini 3.1 Pro in the latest models page.",
    title: "scpFormer: A Foundation Model for Unified Representation",
    abstract: "We present scpFormer, a single-cell foundation model trained on 20M cells across multiple tissue types.",
  },
  {
    label: "cot_leak",
    intro: "最近在跟踪长文本Prompt压缩方向的研究时，读到你的Telegraph English paper，其中用结构化符号重写方法解决提示词语义压缩问题的方案很有启发，如果能有更多算力支持，相信可以在更大规模的开放域数据集上验证该方法的泛化能力。Wait, let me reconsider — the rewrite method might not be the right framing.",
    title: "Telegraph English: Semantic Prompt Compression",
    abstract: "We compress LLM prompts using a learned telegraph-style encoding.",
  },
  {
    label: "off_topic_wrong_paper",
    intro: "最近在跟踪量子计算的研究时，读到你的关于量子退火算法的论文，其中量子比特纠缠解决组合优化问题的方案很有启发，如果能有更多算力支持，相信可以在更大规模的量子模拟器上验证该方法的扩展性。",
    title: "Beyond Safety Filtering: Control Barrier Function-Informed RL for Vehicles",
    abstract: "We use control barrier functions to inform safety-aware reinforcement learning for connected and automated vehicles.",
  },
  {
    label: "prompt_template_leak",
    intro: "最近在跟踪[X方向]的研究时，读到你的[paper名] paper，其中用[Y方法]解决[Z问题]的方案很有启发，如果能有更多算力支持，相信可以在[扩展方向]验证该方法的泛化能力。",
    title: "ImplantMamba: Long-range Sequential Modeling",
    abstract: "We propose ImplantMamba, a state-space model variant for medical implant trajectory forecasting.",
  },
  {
    label: "generic_no_paper_ref",
    intro: "最近在跟踪AI算力相关的研究方向时，读到了您团队的工作，其中的方法很有启发，如果能有更多算力支持，相信可以在更大规模的实验上验证该方法的有效性。",
    title: "Towards Generalized Image Manipulation Localization via Score-based Model",
    abstract: "We propose a score-based model for generalized image manipulation localization.",
  },
];

function buildJudgePrompt(intro, title, abstract) {
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

paper 标题：${title}
paper 摘要（前 800 字）：${(abstract || "").slice(0, 800)}

要审核的 intro：
"""
${intro}
"""

只输出 JSON，不要任何 markdown 或解释。`;
}

async function proxyCall(model, prompt, useJsonMode = true) {
  const body = {
    model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    max_tokens: 1500,
  };
  if (useJsonMode) body.response_format = { type: "json_object" };
  const res = await fetch("https://openai-proxy.miracleplus.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.MIRACLEPLUS_PROXY_KEY}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`proxy ${res.status}: ${text.slice(0, 150)}`);
  return JSON.parse(text)?.choices?.[0]?.message?.content || "";
}
async function geminiCall(prompt) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(process.env.GOOGLE_API_KEY)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 2500 },
      }),
    },
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`gemini ${res.status}: ${text.slice(0, 150)}`);
  return JSON.parse(text)?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}
function parseJ(text) {
  let cleaned = (text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const first = cleaned.indexOf("{"), last = cleaned.lastIndexOf("}");
  if (first >= 0 && last > first) cleaned = cleaned.slice(first, last + 1);
  try {
    const j = JSON.parse(cleaned);
    return {
      instruction_followed: Number(j.instruction_followed),
      paper_relevant: Number(j.paper_relevant),
      should_block: Boolean(j.should_block),
      reasoning: String(j.reasoning || "").slice(0, 150),
    };
  } catch { return { instruction_followed: -1, paper_relevant: -1, should_block: null, reasoning: "parse_fail" }; }
}

for (const s of BAD_SAMPLES) {
  console.log(`\n=== ${s.label} ===`);
  console.log(`  paper: ${s.title.slice(0, 60)}`);
  console.log(`  intro: ${s.intro.slice(0, 100)}${s.intro.length > 100 ? "…" : ""}`);
  const [sonnetRaw, glmRaw, geminiRaw] = await Promise.all([
    proxyCall("claude-sonnet-4-6", buildJudgePrompt(s.intro, s.title, s.abstract), true).catch((e) => ({ error: String(e) })),
    proxyCall("z-ai/glm-4.7", buildJudgePrompt(s.intro, s.title, s.abstract), false).catch((e) => ({ error: String(e) })),
    geminiCall(buildJudgePrompt(s.intro, s.title, s.abstract)).catch((e) => ({ error: String(e) })),
  ]);
  const sonnet = typeof sonnetRaw === "string" ? parseJ(sonnetRaw) : sonnetRaw;
  const glm    = typeof glmRaw === "string" ? parseJ(glmRaw) : glmRaw;
  const gemini = typeof geminiRaw === "string" ? parseJ(geminiRaw) : geminiRaw;
  const votes = [sonnet, glm, gemini].filter((j) => j?.should_block === true).length;
  console.log(`  Sonnet: instr=${sonnet?.instruction_followed} rel=${sonnet?.paper_relevant} block=${sonnet?.should_block}  ${sonnet?.reasoning || ""}`);
  console.log(`  GLM:    instr=${glm?.instruction_followed} rel=${glm?.paper_relevant} block=${glm?.should_block}  ${glm?.reasoning || ""}`);
  console.log(`  Gemini: instr=${gemini?.instruction_followed} rel=${gemini?.paper_relevant} block=${gemini?.should_block}  ${gemini?.reasoning || ""}`);
  console.log(`  VOTES = ${votes}/3 block`);
}
