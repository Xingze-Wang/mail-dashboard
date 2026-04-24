import { NextRequest, NextResponse } from "next/server";
import { verifySession, AUTH_COOKIE } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const session = await verifySession(req.cookies.get(AUTH_COOKIE)?.value);
  if (!session) {
    // 401 is the right contract — clients treating status===200 as
    // "success" were getting false positives. Body still parses to
    // `{authenticated: false}` so existing callers that do
    // `r.json().then(d => d.authenticated ? ... : redirect)` still
    // work (d.authenticated is falsy, redirect fires) without needing
    // to handle r.ok separately.
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }
  return NextResponse.json({
    authenticated: true,
    repId: session.repId,
    repName: session.repName,
    email: session.email,
    role: session.role,
  });
}
