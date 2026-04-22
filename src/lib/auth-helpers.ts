import { NextRequest, NextResponse } from "next/server";
import { verifySession, AUTH_COOKIE, type SessionPayload } from "@/lib/auth";

export async function requireSession(req: NextRequest): Promise<SessionPayload | null> {
  return await verifySession(req.cookies.get(AUTH_COOKIE)?.value);
}

export async function requireAdmin(
  req: NextRequest,
): Promise<{ session: SessionPayload } | { response: NextResponse }> {
  const session = await requireSession(req);
  if (!session) {
    return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  if (session.role !== "admin") {
    return { response: NextResponse.json({ error: "Forbidden — admin only" }, { status: 403 }) };
  }
  return { session };
}

/** Allow admin OR senior — gate hard-flag / blocklist edit / etc. */
export async function requireSenior(
  req: NextRequest,
): Promise<{ session: SessionPayload } | { response: NextResponse }> {
  const session = await requireSession(req);
  if (!session) {
    return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  if (session.role !== "admin" && session.role !== "senior") {
    return { response: NextResponse.json({ error: "Forbidden — senior or admin only" }, { status: 403 }) };
  }
  return { session };
}
