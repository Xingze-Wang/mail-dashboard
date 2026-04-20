import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { supabase } from "@/lib/db";
import { signSession, AUTH_COOKIE, AUTH_COOKIE_MAX_AGE } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { identifier?: string; email?: string; password?: string };
  const identifier = body.identifier ?? body.email;
  const { password } = body;

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

  const role = rep.role === "admin" ? "admin" : "sales";
  const token = await signSession({
    repId: rep.id,
    repName: rep.name,
    email: rep.login_email ?? rep.username ?? rep.name,
    role,
  });

  const res = NextResponse.json({ success: true, repId: rep.id, repName: rep.name, role });
  res.cookies.set(AUTH_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: AUTH_COOKIE_MAX_AGE,
    path: "/",
  });
  return res;
}
