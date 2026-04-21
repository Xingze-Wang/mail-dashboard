// Single client for the MiraclePlus OpenAI-compatible proxy.
// Same idea as /Users/xingzewang/Desktop/Email/llm_client.py — keep them in sync.

const PROXY_URL = "https://openai-proxy.miracleplus.com/v1/chat/completions";

export const KNOWN_MODELS: Record<string, string> = {
  "glm-4.7":        "z-ai/glm-4.7",
  "glm-5":          "z-ai/glm-5",
  "qwen3-235b":     "qwen/qwen3-235b-a22b-2507",
  "qwen3-next-80b": "qwen/qwen3-next-80b-a3b-instruct",
  "deepseek-v3":    "deepseek/deepseek-chat-v3.1",
  "kimi-k2":        "moonshotai/kimi-k2.5",
  "claude-opus":    "anthropic/claude-opus-4.7",
  "claude-sonnet":  "anthropic/claude-sonnet-4.5",
  "gpt-5":          "openai/gpt-5",
  "gpt-5-mini":     "openai/gpt-5-mini",
  "gpt-5-nano":     "openai/gpt-5-nano",
  "gemini-3-pro":   "gemini-3-pro-preview",
  "gemini-3-flash": "google/gemini-3-flash-preview",
  "grok-4":         "x-ai/grok-4",
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

  const body: Record<string, unknown> = {
    model: modelId,
    messages,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.max_tokens ?? 1024,
  };
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
