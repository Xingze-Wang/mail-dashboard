import { NextRequest, NextResponse } from "next/server";
import { runPostmortemDetector } from "@/lib/congress-runners";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Detector only — runs daily, no-op unless a trigger threshold is
// breached. When fired, DMs admin who runs the full forensic congress
// manually (npx tsx scripts/congress-postmortem.ts).
export async function GET(req: NextRequest) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await runPostmortemDetector({ dryRun: false });
  return NextResponse.json(result);
}
