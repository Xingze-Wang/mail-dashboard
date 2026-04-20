import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { signSession, checkPassword, AUTH_COOKIE, AUTH_COOKIE_MAX_AGE } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const { password, repId } = (await req.json()) as { password?: string; repId?: number };

  if (!password || typeof password !== "string") {
    return NextResponse.json({ error: "Missing password" }, { status: 400 });
  }
  if (typeof repId !== "number") {
    return NextResponse.json({ error: "Pick who you are" }, { status: 400 });
  }
  if (!checkPassword(password)) {
    return NextResponse.json({ error: "Wrong password" }, { status: 401 });
  }

  const { data: rep } = await supabase
    .from("sales_reps")
    .select("id,name,active")
    .eq("id", repId)
    .single();

  if (!rep || !rep.active) {
    return NextResponse.json({ error: "Unknown rep" }, { status: 404 });
  }

  const token = signSession({ repId: rep.id, repName: rep.name });
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
