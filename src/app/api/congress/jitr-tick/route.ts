import { NextRequest, NextResponse } from "next/server";
import { spawn } from "node:child_process";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// JITR daily tick. The orchestration is in scripts/jitr-tick.mjs which
// is .mjs and pure node — we shell out from here. (Vercel's serverless
// runtime supports this for Node functions.)
//
// For now: the cron entry exists but the .mjs path doesn't ship with
// the Vercel deploy. Until we either port jitr-tick.mjs into a TS
// runner or include scripts/ in the deploy bundle, this route returns
// a not-implemented note. Run manually: node scripts/jitr-tick.mjs
export async function GET(req: NextRequest) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  void spawn; // referenced so import isn't tree-shaken; replace when we port
  return NextResponse.json({
    ok: true,
    note: "JITR tick stub — run scripts/jitr-tick.mjs manually for now. Port to TS runner before relying on this cron.",
  });
}
