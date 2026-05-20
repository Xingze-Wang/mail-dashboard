// Single client for the MiraclePlus OpenAI-compatible proxy.
// Same idea as /Users/xingzewang/Desktop/Email/llm_client.py — keep them in sync.

const PROXY_URL = "https://openai-proxy.miracleplus.com/v1/chat/completions";

// Curated. Ordered by what we actually want to evaluate first — flagship
// reasoning models at the top, fast/cheap workhorses below, niche at the
// bottom. Short alias → proxy id.
export const KNOWN_MODELS: Record<string, string> = {
  // ───── Frontier flagships ─────
  "claude-opus-4.7":   "anthropic/claude-opus-4.7",
  "claude-opus-4.6":   "anthropic/claude-opus-4.6",
  "claude-opus-4.5":   "anthropic/claude-opus-4.5",
  "claude-sonnet-4.6": "claude-sonnet-4-6",
  "claude-sonnet-4.5": "anthropic/claude-sonnet-4.5",
  "claude-sonnet-3.7": "anthropic/claude-3.7-sonnet",
  "gpt-5":             "openai/gpt-5",
  "gpt-5.2":           "openai/gpt-5.2",
  "gpt-5.1":           "openai/gpt-5.1",
  "gpt-4.1":           "openai/gpt-4.1",
  "gemini-3-pro":      "gemini-3-pro-preview",
  "gemini-2.5-pro":    "gemini-2.5-pro",
  "grok-4":            "x-ai/grok-4",
  "o3":                "openai/o3",
  "o1":                "openai/o1",

  // ───── Fast / cheap workhorses ─────
  // gemini-3.5-flash launched 2026-05-19 at Google I/O. GA, $1.50/$9 per
  // M tokens, default in Gemini app + Search AI Mode. Same SDK endpoint
  // (generativelanguage.googleapis.com). Newer + better than 3-flash-preview.
  "gemini-3.5-flash":  "gemini-3.5-flash",
  "gemini-3-flash":    "gemini-3-flash-preview",
  "gemini-2.5-flash":  "gemini-2.5-flash",
  "gpt-5-mini":        "openai/gpt-5-mini",
  "gpt-5-nano":        "openai/gpt-5-nano",
  "gpt-4.1-mini":      "openai/gpt-4.1-mini",
  "gpt-4.1-nano":      "openai/gpt-4.1-nano",
  "gpt-4o-mini":       "openai/gpt-4o-mini",
  "o4-mini":           "openai/o4-mini",
  "claude-sonnet-4":   "anthropic/claude-sonnet-4",
  "grok-3":            "x-ai/grok-3",

  // ───── Chinese leaders ─────
  "glm-5":               "z-ai/glm-5",
  "glm-4.7":             "z-ai/glm-4.7",
  "glm-4.6":             "z-ai/glm-4.6",
  "qwen3.5-397b":        "qwen/qwen3.5-397b-a17b",
  "qwen3-235b-thinking": "qwen/qwen3-235b-a22b-thinking-2507",
  "qwen3-235b":          "qwen/qwen3-235b-a22b-2507",
  "qwen3-next-80b":      "qwen/qwen3-next-80b-a3b-instruct",
  "qwen3-next-80b-think":"qwen/qwen3-next-80b-a3b-thinking",
  "qwen3-30b":           "qwen/qwen3-30b-a3b-instruct-2507",
  "deepseek-v3":         "deepseek/deepseek-chat-v3.1",
  "kimi-k2":             "moonshotai/kimi-k2.5",
  "kimi-k2-thinking":    "moonshotai/kimi-k2-thinking",

  // ───── Other ─────
  "minimax-m2.5":  "minimax/minimax-m2.5",
  "nemotron-3":    "nvidia/nemotron-3-super-120b-a12b:free",
};

export interface LlmCallResult {
  text: string;
  meta: {
    model: string;
    provider: string | null;
    latency_s: number;
    tokens_in: number | null;
    tokens_out: number | null;
    finish_reason: string | null;
  };
}

export async function llmChat(opts: {
  model: string;
  user: string;
  system?: string;
  temperature?: number;
  max_tokens?: number;
  json?: boolean;
  timeoutMs?: number;
}): Promise<LlmCallResult> {
  const key = process.env.MIRACLEPLUS_PROXY_KEY;
  if (!key) throw new Error("MIRACLEPLUS_PROXY_KEY not set");

  const modelId = KNOWN_MODELS[opts.model] ?? opts.model;
  const messages: Array<{ role: string; content: string }> = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: opts.user });

  // Reasoning models (GPT-5/o-series, qwen *-thinking, kimi *-thinking, glm-4.7+)
  // burn the token budget on internal reasoning before producing any visible
  // output. Detect them and (a) bump the budget significantly, (b) ask for
  // low reasoning effort so we get actual content.
  const isReasoning =
    /^(openai\/(gpt-5|o[13]|o4-mini)|gpt-5|o[13]$|o4-mini)/.test(modelId) ||
    /thinking/.test(modelId) ||
    /^z-ai\/glm/.test(modelId);

  const body: Record<string, unknown> = {
    model: modelId,
    messages,
    temperature: opts.temperature ?? 0.2,
    // Reasoning models need 4-8× more tokens to leave room for the answer.
    max_tokens: isReasoning ? Math.max(opts.max_tokens ?? 1024, 4000) : (opts.max_tokens ?? 1024),
  };
  if (isReasoning) {
    body.reasoning_effort = "low";
  }
  if (opts.json) body.response_format = { type: "json_object" };

  const t0 = Date.now();
  const r = await fetch(PROXY_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });
  const latency_s = Math.round((Date.now() - t0) / 10) / 100;

  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    throw new Error(`proxy HTTP ${r.status}: ${errText.slice(0, 200)}`);
  }
  const data = await r.json();
  const choice = data?.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const text: string = msg.content || msg.reasoning || "";
  if (!text) throw new Error("proxy returned empty content");

  const usage = data?.usage ?? {};
  return {
    text: text.trim(),
    meta: {
      model: data?.model ?? modelId,
      provider: data?.provider ?? null,
      latency_s,
      tokens_in: usage.prompt_tokens ?? null,
      tokens_out: usage.completion_tokens ?? null,
      finish_reason: choice.finish_reason ?? null,
    },
  };
}
