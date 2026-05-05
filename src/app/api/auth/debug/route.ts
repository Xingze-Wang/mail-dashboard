import { NextRequest, NextResponse } from "next/server";
import { verifySession, AUTH_COOKIE } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(AUTH_COOKIE)?.value;
  const authSecretSet = !!process.env.AUTH_SECRET;
  const authSecretLen = process.env.AUTH_SECRET?.length ?? 0;

  let sessionResult: string | null = null;
  let sessionError: string | null = null;

  try {
    const session = await verifySession(token);
    sessionResult = session ? `ok:${session.repId}:${session.repName}` : "null";
  } catch (e) {
    sessionError = e instanceof Error ? e.message : String(e);
  }

  return NextResponse.json({
    has_token: !!token,
    token_length: token?.length ?? 0,
    token_prefix: token?.substring(0, 30),
    auth_secret_set: authSecretSet,
    auth_secret_len: authSecretLen,
    session: sessionResult,
    session_error: sessionError,
  });
}
