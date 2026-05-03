// Vercel cron entry — runs Loop 2 (Weekly Tactical Congress).
// Called from vercel.json `0 1 * * 1` (Monday 1am UTC = Sunday evening US).
//
// This is a wrapper that invokes the same logic as
// scripts/congress-weekly.ts. We can't just shell out from Vercel —
// have to inline the orchestration.

import { NextRequest, NextResponse } from "next/server";
import { runWeeklyCongress } from "@/lib/congress-runners";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 min — 6 personas × ~10s each + DB

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await runWeeklyCongress({ dryRun: false });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err).slice(0, 500) }, { status: 500 });
  }
}
