// MiraclePlus Open API client.
//
// Thin wrapper around https://build-staging.miracleplus.com/open_api/v1.
// Two transports:
//   - mpGetUserMe()                   → health check (GET /user/me)
//   - mpSearchContactsByEmail(email)  → search contacts by email (GET /contacts/search)
//
// Auth: Bearer ${MP_API_TOKEN}. The token is a direct token (NOT an
// OAuth refresh flow). One token = one identity = one tenant scope.
// Do NOT commit the token; it lives in `.env.local` + Vercel env vars.
//
// Error policy: callers get `null` / `[]` on network / 4xx / 5xx /
// parse failures rather than thrown exceptions. The sync layer
// makes its own decision about retry vs skip vs alert.

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Subset of MP's 103-field contact shape, narrowed to the fields the
 * pipeline actually consumes. Extras land in `raw` for forensics.
 *
 * NOTE: in staging, `email` and `phone` are MASKED to `******` /
 * `***5832`. Production is expected to return real values. Name is
 * real in both. We mirror whatever the API gives us; the masking
 * concern is a smoke-test interpretation issue, not a client issue.
 */
export interface MpContact {
  id: number;
  email: string | null;
  name: string | null;
  phone: string | null;
  /** "2024秋季创业营, Submitted" / null = no application of record */
  application_progress: string | null;
  /** "Interview" / "Submitted" / etc — richer than progress alone */
  application_stage: string | null;
  /** Count of applications (int). Conversion signal: > 0 = submitted at least once */
  applications_number: number | null;
  /** "2026-02-04" — date string */
  submitted_at: string | null;
  /** "2026-02-04" — first time they kicked off an application */
  created_application_at: string | null;
  project: string | null;
  s_product: string | null;
  s_channel: string | null;
  utm_source: string | null;
  // Plus ~90 other fields we don't strongly type — preserved on `raw`
  // by the sync layer.
  [key: string]: unknown;
}

export interface MpSearchResponse {
  contacts: MpContact[];
  page: number;
  per_page: number;
  total: number;
}

interface MpEnvelope<T> {
  code: number;
  msg: string;
  data: T;
}

function getBase(): string | null {
  const base = process.env.MP_API_BASE;
  if (!base) return null;
  return base.replace(/\/+$/, "");
}

function getToken(): string | null {
  return process.env.MP_API_TOKEN ?? null;
}

/**
 * Low-level fetch wrapper. Returns `null` on any failure — caller
 * decides whether to surface the error to the user or silently
 * degrade.
 */
async function mpFetch<T>(path: string): Promise<T | null> {
  const base = getBase();
  const token = getToken();
  if (!base || !token) {
    // Misconfigured env. Don't throw — let the sync layer report this
    // as an `errors++` rather than crash the cron.
    console.warn("[mp-api] MP_API_BASE or MP_API_TOKEN not set; skipping call", { path });
    return null;
  }

  const url = `${base}${path}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn("[mp-api] non-2xx", { path, status: res.status, body: body.slice(0, 200) });
      return null;
    }
    const json = (await res.json().catch(() => null)) as MpEnvelope<T> | null;
    if (!json) {
      console.warn("[mp-api] bad JSON", { path });
      return null;
    }
    // MP wraps everything in { code, msg, data }. code=0 means success;
    // anything else is a domain error we treat as failure.
    if (json.code !== 0) {
      console.warn("[mp-api] non-zero code", { path, code: json.code, msg: json.msg });
      return null;
    }
    return json.data;
  } catch (err) {
    console.warn("[mp-api] fetch failed", { path, err: String(err).slice(0, 200) });
    return null;
  }
}

/**
 * Health check. Returns `{ ok: true }` if the API is reachable and the
 * token is valid. NOTE: in staging, /user/me returns 403 with our
 * token — the token is scoped to the contacts namespace and not the
 * user namespace. We fall back to a 1-result contacts search as a
 * functional smoke test; if THAT works, the integration is healthy
 * even if /user/me 403s.
 */
export async function mpGetUserMe(): Promise<{ ok: boolean; reason?: string }> {
  const base = getBase();
  const token = getToken();
  if (!base || !token) return { ok: false, reason: "env vars missing" };

  // Try the canonical health endpoint first.
  try {
    const res = await fetch(`${base}/open_api/v1/user/me`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (res.ok) return { ok: true };
    // Fall through to functional probe — token may be scoped narrower than /user/me.
  } catch {
    /* try the contacts probe */
  }

  // Functional probe: do a 1-row contacts search. If we get the
  // envelope shape back, the token is valid for the namespace we care
  // about.
  const probe = await mpFetch<MpSearchResponse>("/open_api/v1/contacts/search?q=healthcheck@example.com&per=1");
  if (probe !== null) return { ok: true, reason: "/user/me 403 but /contacts/search works" };
  return { ok: false, reason: "both /user/me and /contacts/search failed" };
}

/**
 * Search MP's CRM for contacts matching the given email.
 *
 * Returns `[]` if no match OR on error — caller can't distinguish
 * "we know this email isn't in their CRM" from "API down". For our
 * use case (daily sync), that's acceptable: errors get retried
 * tomorrow and the conversion-matrix view degrades gracefully (a
 * missing row reads as "not yet matched").
 *
 * `per=10` is a safety cap. Real-world we expect 0-1 matches per
 * email since email is supposed to be unique in MP's CRM, but the
 * search endpoint matches across phone/wechat too so duplicates are
 * theoretically possible.
 */
export async function mpSearchContactsByEmail(
  email: string,
): Promise<MpContact[]> {
  const clean = (email ?? "").trim().toLowerCase();
  if (!clean || !clean.includes("@")) return [];
  const data = await mpFetch<MpSearchResponse>(
    `/open_api/v1/contacts/search?q=${encodeURIComponent(clean)}&per=10`,
  );
  if (!data) return [];
  return data.contacts ?? [];
}
