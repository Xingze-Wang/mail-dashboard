import { NextResponse } from "next/server";
import { syncFromResend } from "@/lib/sync";

// GET so Vercel Cron can call it, and the dashboard can trigger it easily
export async function GET() {
  try {
    const result = await syncFromResend();
    return NextResponse.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// POST also works (for manual triggers)
export async function POST() {
  try {
    const result = await syncFromResend();
    return NextResponse.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
