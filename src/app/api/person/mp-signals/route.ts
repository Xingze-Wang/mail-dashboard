import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { getMpSignalsForEmails, type MpLeadSignals } from "@/lib/canonical-counts";

/**
 * GET /api/person/mp-signals?email=foo@bar.com
 *
 * Thin wrapper around getMpSignalsForEmails([email]) for the compose-modal
 * (and any other single-recipient surface). Returns the trio
 * registered / submittedApplication / addedWechat for one email so the
 * sender sees MP conversion state under the "To: ..." line before sending.
 *
 * Cross-rep by design: any logged-in rep can look up any recipient's
 * MP status (the lookup is for outreach context, not ownership).
 *
 * Returns:
 *   { email: string, signals: MpLeadSignals | null }
 * `signals` is null when the email isn't in miracleplus_contacts and
 * has no brief_lookups wechat row (i.e. the absence-as-signal case the
 * MpSignalPills component already renders as ghost pills).
 */
export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const email = (searchParams.get("email") ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "email param required" }, { status: 400 });
  }

  const map = await getMpSignalsForEmails([email]);
  const signals: MpLeadSignals | null = map.get(email) ?? null;
  return NextResponse.json({ email, signals });
}
