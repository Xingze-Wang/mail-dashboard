import { NextRequest, NextResponse } from "next/server";
import { runJitrTick } from "@/lib/congress-runners";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// JITR daily tick. Now wired to the TS runner — the .mjs script path
// is no longer the source of truth (kept for manual local runs only).
export async function GET(req: NextRequest) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await runJitrTick({ dryRun: false });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err).slice(0, 500) }, { status: 500 });
  }
}
