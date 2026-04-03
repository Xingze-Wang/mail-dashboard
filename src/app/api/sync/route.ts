import { NextRequest, NextResponse } from "next/server";
import { syncFromResend } from "@/lib/sync";

// GET for Vercel Cron and internal dashboard calls
export async function GET(req: NextRequest) {
  // Allow Vercel Cron (sends special header) and same-origin requests
  const isVercelCron = req.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
  const referer = req.headers.get("referer") || "";
  const isInternal = referer.includes(req.headers.get("host") || "__none__");

  if (process.env.CRON_SECRET && !isVercelCron && !isInternal) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await syncFromResend();
    return NextResponse.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
