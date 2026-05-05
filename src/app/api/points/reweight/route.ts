// POST /api/points/reweight — refit and publish a new points-table version.
// body: { lookbackDays?: number }

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-helpers";
import { reweightAndPublish } from "@/lib/points-reweight";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const body = await req.json().catch(() => ({}));
  const out = await reweightAndPublish({ lookbackDays: body.lookbackDays });
  return NextResponse.json(out);
}
