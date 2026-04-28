// Embedding helper (Dream #8/#9).
//
// Uses the MiraclePlus OpenAI-compatible proxy (same auth as llm-proxy.ts)
// to generate text-embedding-3-small vectors. 1536 dims, ~$0.01 per
// 1000 leads at openai prices.
//
// One function intentionally — embedText(input). Bulk path is just
// Promise.all over chunks. Keep simple until usage demands batching.

const PROXY_BASE = "https://openai-proxy.miracleplus.com/v1";
const EMBED_MODEL = "openai/text-embedding-3-small";
const EMBED_DIMS = 1536;

export class EmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingError";
  }
}

export async function embedText(input: string): Promise<number[]> {
  const key = process.env.MIRACLEPLUS_PROXY_KEY;
  if (!key) throw new EmbeddingError("MIRACLEPLUS_PROXY_KEY not set");
  const trimmed = input.trim();
  if (!trimmed) throw new EmbeddingError("empty input");

  const res = await fetch(`${PROXY_BASE}/embeddings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: trimmed.slice(0, 8000) }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new EmbeddingError(`embed HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { data?: { embedding?: number[] }[] };
  const v = data?.data?.[0]?.embedding;
  if (!Array.isArray(v) || v.length !== EMBED_DIMS) {
    throw new EmbeddingError(`unexpected embedding shape: len=${v?.length}`);
  }
  return v;
}

/** Format a number array as a pgvector literal: "[0.1,0.2,...]" */
export function vectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}
