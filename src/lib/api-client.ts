// Typed fetch wrapper (Dream #7 / Tier 5 of docs/DATA_INTEGRITY_PLAN.md).
//
// Why: every "the dashboard celebrated, the DB stayed unchanged"
// incident on this codebase came from `fetch(POST/PATCH/DELETE)`
// without a `res.ok` check, or `.catch(() => {})` swallowing the
// failure. The wrapper throws on non-2xx so the only way to suppress
// an error is an explicit try/catch — which is grep-able and
// code-reviewable.
//
// New code MUST use these helpers. Old code is grandfathered until
// touched. `scripts/lint-fetch.mjs` flags non-GET fetch calls outside
// this file so reviewers see the violation.
//
// Shape:
//   const data = await apiPost<{ ok: true }>("/api/foo", { bar: 1 });
//   try { await apiPost(...) } catch (e) { /* explicit handling */ }

export class ApiError extends Error {
  status: number;
  body: unknown;
  url: string;
  constructor(message: string, status: number, body: unknown, url: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  // Try to parse JSON regardless of ok — error responses are also
  // JSON in this codebase (`{ error: "..." }`), and we want that
  // payload attached to the thrown error.
  let parsed: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    const msg =
      typeof parsed === "object" && parsed && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : `${method} ${url} failed (HTTP ${res.status})`;
    throw new ApiError(msg, res.status, parsed, url);
  }
  return parsed as T;
}

export function apiPost<T = unknown>(url: string, body?: unknown): Promise<T> {
  return call<T>("POST", url, body);
}

export function apiPatch<T = unknown>(url: string, body?: unknown): Promise<T> {
  return call<T>("PATCH", url, body);
}

export function apiPut<T = unknown>(url: string, body?: unknown): Promise<T> {
  return call<T>("PUT", url, body);
}

export function apiDelete<T = unknown>(url: string, body?: unknown): Promise<T> {
  return call<T>("DELETE", url, body);
}

/**
 * GET helper too — not strictly needed for the safety story (read
 * paths fail-closed already because consumers branch on returned
 * data), but symmetry helps and the typed return signature is nice.
 */
export function apiGet<T = unknown>(url: string): Promise<T> {
  return call<T>("GET", url);
}
