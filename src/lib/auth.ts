import { SignJWT, jwtVerify } from "jose";

const COOKIE_NAME = "qiji_session";
const SESSION_DAYS = 30;
const ALG = "HS256";

function getKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET env var is required");
  return new TextEncoder().encode(secret);
}

// Role hierarchy (ascending power):
//   sales  — default junior rep; can flag leads as soft notes, but their
//            good_lead / bad_compute flags are NOT used for training.
//   senior — trusted rep; their good_lead / bad_compute can feed training
//            (small weight), and they can hard-flag leads into blocklist.
//   admin  — everything + prompt/rule editing.
export type Role = "admin" | "senior" | "sales";

export interface SessionPayload {
  repId: number;
  repName: string;
  email: string;
  role: Role;
}

export async function signSession(payload: SessionPayload): Promise<string> {
  return await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(getKey());
}

export async function verifySession(token: string | undefined): Promise<SessionPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getKey(), { algorithms: [ALG] });
    if (
      typeof payload.repId === "number" &&
      typeof payload.repName === "string" &&
      typeof payload.email === "string"
    ) {
      const role: Role =
        payload.role === "admin" ? "admin" :
        payload.role === "senior" ? "senior" : "sales";
      return {
        repId: payload.repId,
        repName: payload.repName,
        email: payload.email,
        role,
      };
    }
    return null;
  } catch (e) {
    console.error("[verifySession] jose error:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

export const AUTH_COOKIE = COOKIE_NAME;
export const AUTH_COOKIE_MAX_AGE = SESSION_DAYS * 86400;

// ─── Multi-account pool ───────────────────────────────────────────────
//
// `qiji_session_pool` holds a JSON array of signed JWTs — every session the
// user has added. The ACTIVE session stays in `qiji_session`. On login with
// ?stack=1 we append; on switch we copy the chosen JWT → active; on remove
// we drop it.
//
// Storing full JWTs (not just repIds) means every switch reuses an existing
// authenticated token without re-validating credentials. When a pool entry
// expires we drop it silently on read.

const POOL_COOKIE = "qiji_session_pool";

export const AUTH_POOL_COOKIE = POOL_COOKIE;

/** Read and validate the pool. Expired / invalid tokens are silently dropped. */
export async function readPool(raw: string | undefined): Promise<{ token: string; session: SessionPayload }[]> {
  if (!raw) return [];
  let tokens: unknown;
  try {
    tokens = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(tokens)) return [];
  const valid: { token: string; session: SessionPayload }[] = [];
  for (const t of tokens) {
    if (typeof t !== "string") continue;
    const s = await verifySession(t);
    if (s) valid.push({ token: t, session: s });
  }
  return valid;
}

/** Serialize a list of tokens back into a cookie value. */
export function serializePool(tokens: string[]): string {
  return JSON.stringify(tokens);
}
