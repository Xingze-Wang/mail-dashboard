import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { runIntegrity } from "@/lib/integrity";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/integrity
 *
 * Tier 6 of docs/DATA_INTEGRITY_PLAN.md. Returns the daily integrity
 * report — every "the dashboard would lie if this drifted" invariant
 * with a green/yellow/red severity. The admin dashboard tile reads
 * this and renders one row per check; cron also runs this and includes
 * it in the daily response so the run trail captures the snapshot.
 *
 * Admin-only because the detail strings include rep names and counts
 * that aren't appropriate for sales-side surface area.
 */
export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const report = await runIntegrity();
  return NextResponse.json(report);
}
