import { NextRequest, NextResponse } from "next/server";
import { runMonthlyCongress } from "@/lib/congress-runners";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await runMonthlyCongress({ dryRun: false });
  return NextResponse.json(result);
}
