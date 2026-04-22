import { NextRequest, NextResponse } from "next/server";
import { verifySession, AUTH_COOKIE } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const session = await verifySession(req.cookies.get(AUTH_COOKIE)?.value);
  if (!session) return NextResponse.json({ authenticated: false }, { status: 200 });
  return NextResponse.json({
    authenticated: true,
    repId: session.repId,
    repName: session.repName,
    email: session.email,
    role: session.role,
  });
}
