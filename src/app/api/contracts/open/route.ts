// POST /api/contracts/open — open a new company contract.
// body: { company_id, investor_id, action_label, target_score, capital_staked, rep_id?, segment?, action_spec?, prediction?, duration_days? }

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-helpers";
import { openContract } from "@/lib/contracts";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const body = await req.json().catch(() => ({}));
  if (!body.company_id || !body.action_label || body.target_score == null || body.capital_staked == null) {
    return NextResponse.json({ error: "company_id, action_label, target_score, capital_staked required" }, { status: 400 });
  }

  const result = await openContract({
    company_id: body.company_id,
    investor_id: body.investor_id ?? "00000000-0000-0000-0000-000000000001",
    action_label: body.action_label,
    target_score: Number(body.target_score),
    capital_staked: Number(body.capital_staked),
    rep_id: body.rep_id ?? null,
    segment: body.segment ?? null,
    action_spec: body.action_spec ?? {},
    prediction: body.prediction ?? "",
    duration_days: body.duration_days ?? 7,
  });

  if ("error" in result) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json(result);
}
