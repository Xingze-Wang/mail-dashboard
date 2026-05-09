import { NextRequest, NextResponse } from "next/server";
import { runHypothesisCongress } from "@/lib/congress-hypothesis";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * GET /api/cron/congress-hypothesis
 *
 * Hypothesis-driven congress runner. Reads active hypotheses, scores
 * outcomes for ones in 'testing', generates new hypotheses with CoT
 * reasoning over qualitative dimensions (city tier, school culture,
 * naming conventions, time-of-day, lab seniority), drafts template
 * proposals for the strongest, mirrors to admin_inbox.
 *
 * Schedule (vercel.json): "0 4 * * *" — daily at noon Beijing.
 * Frequency tradeoff: data accumulates slowly so daily is overkill,
 * but we want fast turnaround on the loop ("hypothesis → test →
 * outcome → new hypothesis"). Daily is cheap (Gemini ~3 calls) and
 * keeps admin's inbox steadily fed.
 *
 * Auth: Bearer CRON_SECRET. Same pattern as other crons. Also
 * accepts ?force=1 query param for ad-hoc triggers (still requires
 * the bearer token).
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await runHypothesisCongress({ lookbackDays: 30 });
  return NextResponse.json(result);
}
