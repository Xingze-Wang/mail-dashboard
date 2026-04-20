import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { supabase } from "@/lib/db";
import { signSession, AUTH_COOKIE, AUTH_COOKIE_MAX_AGE } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const { email, password } = (await req.json()) as { email?: string; password?: string };

  if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
    return NextResponse.json({ error: "Email and password required" }, { status: 400 });
  }

  const normalized = email.trim().toLowerCase();

  const { data: rep } = await supabase
    .from("sales_reps")
    .select("id,name,login_email,password_hash,active")
    .ilike("login_email", normalized)
    .single();

  // Always compare against a valid hash to keep timing constant — defends
  // against email-enumeration. The dummy hash is bcrypt(""), 10 rounds.
  const dummy = "$2b$10$abcdefghijklmnopqrstuO0a4DV5kCmwk2OW.aBp99oeVXfApEZAi";
  const hashToCompare = rep?.password_hash || dummy;
  const ok = await bcrypt.compare(password, hashToCompare);

  if (!rep || !rep.active || !rep.password_hash || !ok) {
    return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
  }

  const token = await signSession({
    repId: rep.id,
    repName: rep.name,
    email: rep.login_email,
  });

  const res = NextResponse.json({ success: true, repId: rep.id, repName: rep.name });
  res.cookies.set(AUTH_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: AUTH_COOKIE_MAX_AGE,
    path: "/",
  });
  return res;
}
