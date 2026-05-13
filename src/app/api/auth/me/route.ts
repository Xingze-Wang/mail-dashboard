import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { supabase } from "@/lib/db";

/**
 * GET /api/auth/me
 *
 * Returns the current session's identity AND DB-fresh role.
 *
 * Why DB-fresh: the JWT cookie is 30 days. A demoted admin would
 * otherwise keep seeing role:"admin" in the response (and the UI
 * would keep showing admin chrome) for up to a month. requireSession
 * re-reads sales_reps.role on every call, which is the contract
 * CLAUDE.md mandates. It also rejects ghost-rep tokens (JWT
 * referencing a deleted/deactivated rep) by returning null.
 *
 * Auth: any session, anonymous gets {authenticated: false}.
 */
export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) {
    // 401 is the right contract — clients treating status===200 as
    // "success" were getting false positives. Body still parses to
    // `{authenticated: false}` so existing callers that do
    // `r.json().then(d => d.authenticated ? ... : redirect)` still
    // work (d.authenticated is falsy, redirect fires) without needing
    // to handle r.ok separately.
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }
  // Pull created_at for MissionsDot new-rep empty-state.
  const { data: rep } = await supabase
    .from("sales_reps")
    .select("created_at")
    .eq("id", session.repId)
    .maybeSingle();
  return NextResponse.json({
    authenticated: true,
    repId: session.repId,
    repName: session.repName,
    email: session.email,
    role: session.role,
    repCreatedAt: rep?.created_at ?? null,
  });
}
