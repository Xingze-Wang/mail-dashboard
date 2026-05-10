import { NextRequest, NextResponse } from "next/server";
import {
  AUTH_COOKIE, AUTH_COOKIE_MAX_AGE, AUTH_POOL_COOKIE,
  readPool, serializePool, verifySession,
} from "@/lib/auth";

/**
 * POST /api/auth/remove  { repId }
 * Drops one account from the pool. If it was the active one, promote
 * whichever is first in the remaining pool. If the pool is empty, clear
 * both cookies — this is effectively "sign out last account".
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { repId?: number };
  const targetRepId = body.repId;
  if (typeof targetRepId !== "number") {
    return NextResponse.json({ error: "repId required" }, { status: 400 });
  }

  const pool = await readPool(req.cookies.get(AUTH_POOL_COOKIE)?.value);
  const activeToken = req.cookies.get(AUTH_COOKIE)?.value;
  const activeSession = await verifySession(activeToken);

  const remaining = pool.filter((p) => p.session.repId !== targetRepId);
  const removedWasActive = activeSession?.repId === targetRepId;

  const res = NextResponse.json({ ok: true });

  if (removedWasActive) {
    if (remaining.length > 0) {
      // Promote first remaining to active.
      res.cookies.set(AUTH_COOKIE, remaining[0].token, {
        httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax",
        maxAge: AUTH_COOKIE_MAX_AGE, path: "/",
      });
      res.cookies.set(AUTH_POOL_COOKIE, serializePool(remaining.slice(1).map((r) => r.token)), {
        httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax",
        maxAge: AUTH_COOKIE_MAX_AGE, path: "/",
      });
    } else {
      // Pool is empty — sign out completely.
      res.cookies.delete(AUTH_COOKIE);
      res.cookies.delete(AUTH_POOL_COOKIE);
    }
  } else {
    // Active session untouched; just update the pool.
    res.cookies.set(AUTH_POOL_COOKIE, serializePool(remaining.map((r) => r.token)), {
      httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax",
      maxAge: AUTH_COOKIE_MAX_AGE, path: "/",
    });
  }

  return res;
}
