import { NextRequest, NextResponse } from "next/server";
import { verifySession, AUTH_COOKIE, type SessionPayload, type Role } from "@/lib/auth";
import { supabase } from "@/lib/db";

/**
 * Returns the current session, with `role` RE-READ FROM THE DB on every
 * call. The JWT's role field is NEVER trusted for authorization. Why:
 *
 *   A user's role in sales_reps can change (demotion from admin → sales
 *   while they're logged in). The JWT is a 30-day cookie, so a user who
 *   was 'admin' at login and is now 'sales' in the DB would still see
 *   every rep's leads if we trusted JWT.role. That's exactly the
 *   "sales still sees all leads" bug.
 *
 * If the rep row is missing (deleted/inactive) or we can't reach the DB,
 * fail CLOSED: return null so the caller rejects the request.
 */
export async function requireSession(req: NextRequest): Promise<SessionPayload | null> {
  const jwt = await verifySession(req.cookies.get(AUTH_COOKIE)?.value);
  if (!jwt) return null;

  // Re-read current role + active status from DB.
  const { data: rep, error } = await supabase
    .from("sales_reps")
    .select("role, active")
    .eq("id", jwt.repId)
    .maybeSingle();

  // If the lookup errored, fail closed — we don't know the role so we
  // can't safely grant anything. Better to 401 a user for a few seconds
  // than leak every rep's leads during a DB blip.
  if (error) {
    console.error("requireSession: DB role lookup failed — failing closed", error);
    return null;
  }
  // Inactive / deleted rep → no access.
  if (!rep || rep.active === false) return null;

  const live: Role =
    rep.role === "admin" ? "admin" :
    rep.role === "senior" ? "senior" :
    "sales";

  return { ...jwt, role: live };
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
