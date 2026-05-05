// Pluggable adapter layer. Add new targets by adding a factory here and
// registering in `getAdapter()`. Config is read from env to keep the CLI
// surface stable across targets.

import type { Adapter, AdapterResult } from "./types.js";

export function getAdapter(name: string): Adapter {
  switch (name) {
    case "openai":
    case "openai-compat":
      return openAICompatAdapter();
    case "echo":
      return echoAdapter();
    case "webhook":
      return webhookAdapter();
    default:
      throw new Error(
        `Unknown adapter "${name}". Built-in adapters: openai, webhook, echo.`,
      );
  }
}

// OpenAI-compatible /chat/completions adapter.
// Works with OpenAI, Together, Groq, OpenRouter, vLLM, Ollama (with /v1), etc.
// Env:
//   PROMPT_HACKER_BASE_URL   default https://api.openai.com/v1
//   PROMPT_HACKER_API_KEY    bearer token (required unless dry-run)
//   PROMPT_HACKER_MODEL      default gpt-4o-mini
//   PROMPT_HACKER_SYSTEM     optional system message
function openAICompatAdapter(): Adapter {
  const baseUrl = process.env.PROMPT_HACKER_BASE_URL ?? "https://api.openai.com/v1";
  const apiKey = process.env.PROMPT_HACKER_API_KEY ?? "";
  const model = process.env.PROMPT_HACKER_MODEL ?? "gpt-4o-mini";
  const system = process.env.PROMPT_HACKER_SYSTEM ?? "";

  return {
    name: `openai-compat:${model}`,
    dryInit() {
      if (!apiKey) {
        return {
          ok: false,
          reason: "PROMPT_HACKER_API_KEY is not set (required for live runs).",
        };
      }
      return { ok: true };
    },
    async send(prompt: string): Promise<AdapterResult> {
      const t0 = Date.now();
      try {
        const messages: Array<{ role: string; content: string }> = [];
        if (system) messages.push({ role: "system", content: system });
        messages.push({ role: "user", content: prompt });

        const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ model, messages, temperature: 0 }),
        });
        const latency = Date.now() - t0;
        if (!res.ok) {
          const body = await res.text();
          return {
            ok: false,
            text: "",
            error: `HTTP ${res.status}: ${body.slice(0, 500)}`,
            latency_ms: latency,
          };
        }
        const json = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const text = json.choices?.[0]?.message?.content ?? "";
        return { ok: true, text, raw: json, latency_ms: latency };
      } catch (err) {
        return {
          ok: false,
          text: "",
          error: err instanceof Error ? err.message : String(err),
          latency_ms: Date.now() - t0,
        };
      }
    },
  };
}

// Generic webhook adapter — POSTs { prompt } to PROMPT_HACKER_WEBHOOK_URL,
// optional bearer via PROMPT_HACKER_WEBHOOK_AUTH. Expects { reply: string }.
// Useful for testing your own bot's /api/help/ask or similar.
function webhookAdapter(): Adapter {
  const url = process.env.PROMPT_HACKER_WEBHOOK_URL ?? "";
  const auth = process.env.PROMPT_HACKER_WEBHOOK_AUTH ?? "";
  const replyKey = process.env.PROMPT_HACKER_WEBHOOK_REPLY_KEY ?? "reply";

  return {
    name: `webhook:${url || "<unset>"}`,
    dryInit() {
      if (!url) {
        return { ok: false, reason: "PROMPT_HACKER_WEBHOOK_URL is not set." };
      }
      return { ok: true };
    },
    async send(prompt: string): Promise<AdapterResult> {
      const t0 = Date.now();
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (auth) headers.Authorization = auth.startsWith("Bearer ") ? auth : `Bearer ${auth}`;
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt }),
        });
        const latency = Date.now() - t0;
        if (!res.ok) {
          const body = await res.text();
          return {
            ok: false,
            text: "",
            error: `HTTP ${res.status}: ${body.slice(0, 500)}`,
            latency_ms: latency,
          };
        }
        const json = (await res.json()) as Record<string, unknown>;
        const text = String(json[replyKey] ?? "");
        return { ok: true, text, raw: json, latency_ms: latency };
      } catch (err) {
        return {
          ok: false,
          text: "",
          error: err instanceof Error ? err.message : String(err),
          latency_ms: Date.now() - t0,
        };
      }
    },
  };
}

// Echo adapter — returns the prompt back. Used in --dry-run smoke tests.
function echoAdapter(): Adapter {
  return {
    name: "echo",
    dryInit() {
      return { ok: true };
    },
    async send(prompt: string): Promise<AdapterResult> {
      return {
        ok: true,
        text: `[echo] received ${prompt.length} chars`,
        latency_ms: 0,
      };
    },
  };
}
