import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { supabase } from "@/lib/db";
import {
  signSession, verifySession,
  AUTH_COOKIE, AUTH_COOKIE_MAX_AGE, AUTH_POOL_COOKIE,
  readPool, serializePool,
} from "@/lib/auth";

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { identifier?: string; email?: string; password?: string; stack?: boolean };
  const identifier = body.identifier ?? body.email;
  const { password } = body;
  const stack = body.stack === true;

  if (typeof identifier !== "string" || typeof password !== "string" || !identifier || !password) {
    return NextResponse.json({ error: "Username and password required" }, { status: 400 });
  }

  const normalized = identifier.trim().toLowerCase();
  const isEmail = normalized.includes("@");
  const column = isEmail ? "login_email" : "username";

  const { data: rep } = await supabase
    .from("sales_reps")
    .select("id,name,login_email,username,password_hash,active,role")
    .ilike(column, normalized)
    .single();

  // Always compare against a valid hash to keep timing constant — defends
  // against username-enumeration. The dummy hash is bcrypt(""), 10 rounds.
  const dummy = "$2b$10$abcdefghijklmnopqrstuO0a4DV5kCmwk2OW.aBp99oeVXfApEZAi";
  const hashToCompare = rep?.password_hash || dummy;
  const ok = await bcrypt.compare(password, hashToCompare);

  if (!rep || !rep.active || !rep.password_hash || !ok) {
    return NextResponse.json({ error: "Invalid username or password" }, { status: 401 });
  }

  const role: "admin" | "senior" | "sales" =
    rep.role === "admin" ? "admin" :
    rep.role === "senior" ? "senior" : "sales";
  const token = await signSession({
    repId: rep.id,
    repName: rep.name,
    email: rep.login_email ?? rep.username ?? rep.name,
    role,
  });

  const res = NextResponse.json({ success: true, repId: rep.id, repName: rep.name, role });
  res.cookies.set(AUTH_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: AUTH_COOKIE_MAX_AGE,
    path: "/",
  });

  // Build the new pool: existing pool + current active (if not already in
  // pool) + the token we just minted. Dedup by repId — if the user is
  // already in the pool, replace their token with the fresh one.
  const existingPool = await readPool(req.cookies.get(AUTH_POOL_COOKIE)?.value);
  const pooledTokens: string[] = [];
  const seenRepIds = new Set<number>();

  // If stacking, keep existing accounts first (they're still signed in).
  // If not stacking but the previous active token is still valid, we drop
  // it — classic "log in as someone else" replaces.
  if (stack) {
    const prevActiveToken = req.cookies.get(AUTH_COOKIE)?.value;
    if (prevActiveToken) {
      const prevSession = await verifySession(prevActiveToken);
      if (prevSession && prevSession.repId !== rep.id) {
        pooledTokens.push(prevActiveToken);
        seenRepIds.add(prevSession.repId);
      }
    }
    for (const entry of existingPool) {
      if (entry.session.repId === rep.id) continue; // will be replaced by fresh token below
      if (seenRepIds.has(entry.session.repId)) continue;
      pooledTokens.push(entry.token);
      seenRepIds.add(entry.session.repId);
    }
  }
  // Always include the fresh token at the end.
  pooledTokens.push(token);

  res.cookies.set(AUTH_POOL_COOKIE, serializePool(pooledTokens), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: AUTH_COOKIE_MAX_AGE,
    path: "/",
  });
  return res;
}
