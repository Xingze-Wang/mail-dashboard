import { NextRequest, NextResponse } from "next/server";
import {
  AUTH_COOKIE, AUTH_COOKIE_MAX_AGE, AUTH_POOL_COOKIE,
  readPool, serializePool, verifySession,
} from "@/lib/auth";

/**
 * POST /api/auth/switch  { repId }
 * Copies the pool's token for that rep into the active session cookie. No
 * password check — if a token is in the pool it's already signed & valid.
 * The old active session is preserved in the pool so switch-back works.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { repId?: number };
  const targetRepId = body.repId;
  if (typeof targetRepId !== "number") {
    return NextResponse.json({ error: "repId required" }, { status: 400 });
  }

  const pool = await readPool(req.cookies.get(AUTH_POOL_COOKIE)?.value);
  const target = pool.find((p) => p.session.repId === targetRepId);

  // Also consider the current active token — the user may be switching into
  // an account that's only in the active slot (not yet pooled).
  const activeToken = req.cookies.get(AUTH_COOKIE)?.value;
  const activeSession = await verifySession(activeToken);

  let chosenToken: string | null = null;
  if (target) chosenToken = target.token;
  else if (activeSession?.repId === targetRepId && activeToken) chosenToken = activeToken;

  if (!chosenToken) {
    return NextResponse.json({ error: "Account not in pool. Sign in again." }, { status: 404 });
  }

  // Build the updated pool — include every valid token EXCEPT the newly
  // active one (we don't keep dupes), plus the previously-active token
  // if it was different.
  const nextPool: string[] = [];
  const seenRepIds = new Set<number>([targetRepId]);
  if (activeSession && activeSession.repId !== targetRepId && activeToken) {
    nextPool.push(activeToken);
    seenRepIds.add(activeSession.repId);
  }
  for (const entry of pool) {
    if (seenRepIds.has(entry.session.repId)) continue;
    nextPool.push(entry.token);
    seenRepIds.add(entry.session.repId);
  }

  const res = NextResponse.json({ ok: true, repId: targetRepId });
  res.cookies.set(AUTH_COOKIE, chosenToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: AUTH_COOKIE_MAX_AGE,
    path: "/",
  });
  res.cookies.set(AUTH_POOL_COOKIE, serializePool(nextPool), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: AUTH_COOKIE_MAX_AGE,
    path: "/",
  });
  return res;
}
