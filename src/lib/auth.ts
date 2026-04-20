import { SignJWT, jwtVerify } from "jose";

const COOKIE_NAME = "qiji_session";
const SESSION_DAYS = 30;
const ALG = "HS256";

function getKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET env var is required");
  return new TextEncoder().encode(secret);
}

export interface SessionPayload {
  repId: number;
  repName: string;
  email: string;
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
      return { repId: payload.repId, repName: payload.repName, email: payload.email };
    }
    return null;
  } catch {
    return null;
  }
}

export const AUTH_COOKIE = COOKIE_NAME;
export const AUTH_COOKIE_MAX_AGE = SESSION_DAYS * 86400;
