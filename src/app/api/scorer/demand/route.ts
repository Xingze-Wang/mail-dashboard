// GET /api/scorer/demand — multi-model demand calibration.
// POST /api/scorer/demand — refresh + ask congress for interpretation.

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-helpers";
import { calibrateModels, congressInterpretCalibration } from "@/lib/demand-signal";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;
  const url = new URL(req.url);
  const lookback = Math.max(7, Math.min(180, Number(url.searchParams.get("days") ?? "60")));
  const r = await calibrateModels({ lookbackDays: lookback, limit: 300 });
  return NextResponse.json(r);
}

export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;
  const r = await calibrateModels({ lookbackDays: 60, limit: 300 });
  if (!r.ok) return NextResponse.json(r, { status: 500 });
  const c = await congressInterpretCalibration(r);
  return NextResponse.json({ calibration: r, commentary: c.commentary, error: c.error });
}
