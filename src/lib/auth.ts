import { createHmac, timingSafeEqual } from "crypto";

const COOKIE_NAME = "qiji_session";
const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 86_400_000;

function secret(): string {
  return process.env.AUTH_SECRET || process.env.AUTH_PASSWORD || "qiji-dev-secret-change-me";
}

function b64url(buf: Buffer | string): string {
  return (typeof buf === "string" ? Buffer.from(buf) : buf)
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

export interface SessionPayload {
  repId: number;
  repName: string;
  exp: number;
}

export function signSession(payload: Omit<SessionPayload, "exp">): string {
  const full: SessionPayload = { ...payload, exp: Date.now() + SESSION_MS };
  const body = b64url(JSON.stringify(full));
  const sig = b64url(createHmac("sha256", secret()).update(body).digest());
  return `${body}.${sig}`;
}

export function verifySession(token: string | undefined): SessionPayload | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret()).update(body).digest();
  let actual: Buffer;
  try {
    actual = b64urlDecode(sig);
  } catch {
    return null;
  }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const payload = JSON.parse(b64urlDecode(body).toString()) as SessionPayload;
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    if (typeof payload.repId !== "number" || typeof payload.repName !== "string") return null;
    return payload;
  } catch {
    return null;
  }
}

export function checkPassword(input: string): boolean {
  const expected = process.env.AUTH_PASSWORD;
  if (!expected) return false;
  const a = Buffer.from(input);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const AUTH_COOKIE = COOKIE_NAME;
export const AUTH_COOKIE_MAX_AGE = SESSION_DAYS * 86400;
