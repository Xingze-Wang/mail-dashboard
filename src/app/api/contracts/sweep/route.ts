// POST /api/contracts/sweep — settle every open contract whose closes_at
// has passed. Idempotent. Called by cron and by admin "Settle now" button.

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-helpers";
import { sweepClosedContracts } from "@/lib/contracts";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;
  const out = await sweepClosedContracts();
  return NextResponse.json(out);
}
