import { NextRequest, NextResponse } from "next/server";
import {
  AUTH_COOKIE, AUTH_POOL_COOKIE,
  readPool, verifySession,
} from "@/lib/auth";

/**
 * GET /api/auth/accounts
 * Returns the list of accounts currently in the session pool + which is
 * active. Safe to call without admin rights — you only see your own pool
 * (it's tied to this browser's cookies).
 */
export async function GET(req: NextRequest) {
  const activeToken = req.cookies.get(AUTH_COOKIE)?.value;
  const activeSession = await verifySession(activeToken);
  const pool = await readPool(req.cookies.get(AUTH_POOL_COOKIE)?.value);

  // Include the active session in the listing even if it happens not to
  // be in the pool (back-compat for users who logged in before multi-account
  // existed).
  const seen = new Set<number>();
  const accounts: { repId: number; repName: string; email: string; role: string; active: boolean }[] = [];
  if (activeSession) {
    accounts.push({
      repId: activeSession.repId,
      repName: activeSession.repName,
      email: activeSession.email,
      role: activeSession.role,
      active: true,
    });
    seen.add(activeSession.repId);
  }
  for (const entry of pool) {
    if (seen.has(entry.session.repId)) continue;
    accounts.push({
      repId: entry.session.repId,
      repName: entry.session.repName,
      email: entry.session.email,
      role: entry.session.role,
      active: false,
    });
    seen.add(entry.session.repId);
  }

  return NextResponse.json({ accounts });
}
