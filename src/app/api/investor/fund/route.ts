// POST /api/investor/fund
// body: { investor_id: uuid, company_id: uuid, thesis: string, conviction?: number, rationale?: string }
//
// Writes:
//  - bench_companies.funded_by, funded_at, thesis (if not already set)
//  - investor_bets row (action: "fund")
//  - company_lifecycle row (event: "funded")

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

interface FundBody {
  investor_id: string;
  company_id: string;
  thesis: string;
  conviction?: number;
  rationale?: string;
}

export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const body = (await req.json().catch(() => ({}))) as Partial<FundBody>;
  if (!body.investor_id || !body.company_id || !body.thesis) {
    return NextResponse.json({ error: "investor_id, company_id, thesis required" }, { status: 400 });
  }

  const { data: investor } = await supabase
    .from("investor_agents")
    .select("id, default_conviction, name")
    .eq("id", body.investor_id)
    .maybeSingle();
  if (!investor) return NextResponse.json({ error: "investor not found" }, { status: 404 });

  const conviction = body.conviction ?? (investor.default_conviction as number) ?? 0.5;
  if (conviction < 0 || conviction > 1) {
    return NextResponse.json({ error: "conviction must be in [0, 1]" }, { status: 400 });
  }

  const now = new Date().toISOString();

  // Mark the company funded. Don't overwrite an existing thesis silently —
  // only set on first funding.
  const { data: existingCompany } = await supabase
    .from("bench_companies")
    .select("id, thesis")
    .eq("id", body.company_id)
    .maybeSingle();
  if (!existingCompany) return NextResponse.json({ error: "company not found" }, { status: 404 });

  const update: Record<string, unknown> = {
    funded_by: investor.id,
    funded_at: now,
    active: true,
  };
  if (!existingCompany.thesis) update.thesis = body.thesis;

  await supabase.from("bench_companies").update(update).eq("id", body.company_id);

  await supabase.from("investor_bets").insert({
    investor_id: investor.id,
    company_id: body.company_id,
    conviction,
    action: "fund",
    rationale: body.rationale ?? `Funded by ${investor.name}: "${body.thesis}"`,
    metric_snapshot: {},
    decided_at: now,
  });

  await supabase.from("company_lifecycle").insert({
    company_id: body.company_id,
    event: "funded",
    label: `Funded by ${investor.name}`,
    meta: { investor_id: investor.id, thesis: body.thesis, conviction },
    occurred_at: now,
  });

  return NextResponse.json({ ok: true, conviction, funded_at: now });
}
