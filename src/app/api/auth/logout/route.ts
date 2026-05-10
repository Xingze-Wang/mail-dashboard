import { NextRequest, NextResponse } from "next/server";
import {
  AUTH_COOKIE, AUTH_COOKIE_MAX_AGE, AUTH_POOL_COOKIE,
  readPool, serializePool, verifySession,
} from "@/lib/auth";

/**
 * POST /api/auth/logout
 *
 * If there are other accounts in the session pool, the current active one is
 * dropped and the next pooled account becomes active (so the user lands on
 * a still-signed-in state). If the pool is empty, both cookies are cleared
 * — classic sign-out.
 */
export async function POST(req: NextRequest) {
  const activeToken = req.cookies.get(AUTH_COOKIE)?.value;
  const activeSession = await verifySession(activeToken);
  const pool = await readPool(req.cookies.get(AUTH_POOL_COOKIE)?.value);

  // Pool should not contain the active one (we keep those separate), but
  // be defensive.
  const remaining = activeSession
    ? pool.filter((p) => p.session.repId !== activeSession.repId)
    : pool;

  const res = NextResponse.json({ success: true, rotatedTo: remaining[0]?.session.repId ?? null });

  if (remaining.length > 0) {
    res.cookies.set(AUTH_COOKIE, remaining[0].token, {
      httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax",
      maxAge: AUTH_COOKIE_MAX_AGE, path: "/",
    });
    res.cookies.set(AUTH_POOL_COOKIE, serializePool(remaining.slice(1).map((r) => r.token)), {
      httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax",
      maxAge: AUTH_COOKIE_MAX_AGE, path: "/",
    });
  } else {
    res.cookies.set(AUTH_COOKIE, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: 0, path: "/" });
    res.cookies.set(AUTH_POOL_COOKIE, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: 0, path: "/" });
  }
  return res;
}
