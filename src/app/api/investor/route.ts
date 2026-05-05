// GET  /api/investor          → list active investor agents + their portfolios
// POST /api/investor/fund     → fund a company (manual or by an investor agent)
// POST /api/investor/tick     → investor reviews portfolio, writes new bets
//
// This file ships only the GET. Fund/tick live at sub-routes for clarity.

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";
import type { InvestorAgent, InvestorBet, CompanyLifecycle, CompanyWithPortfolio } from "@/lib/investor-types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const [{ data: investors }, { data: companies }, { data: bets }, { data: events }, { data: ledger }] = await Promise.all([
    supabase.from("investor_agents").select("*").eq("active", true).order("created_at", { ascending: true }),
    supabase.from("bench_companies").select("id, name, tagline, thesis, target_segment, funded_by, funded_at, active, color").order("created_at", { ascending: true }),
    supabase.from("investor_bets").select("*").order("decided_at", { ascending: false }).limit(200),
    supabase.from("company_lifecycle").select("*").order("occurred_at", { ascending: false }).limit(200),
    supabase.from("investor_capital_ledger").select("investor_id, balance_after, occurred_at").order("occurred_at", { ascending: false }),
  ]);

  // Latest balance per investor.
  const balanceByInvestor = new Map<string, number>();
  for (const row of ledger ?? []) {
    if (!balanceByInvestor.has(row.investor_id as string)) {
      balanceByInvestor.set(row.investor_id as string, Number(row.balance_after));
    }
  }

  // Build per-company latest_bet + recent_events.
  const latestBetByCompany = new Map<string, InvestorBet>();
  for (const b of (bets ?? []) as InvestorBet[]) {
    if (!latestBetByCompany.has(b.company_id)) latestBetByCompany.set(b.company_id, b);
  }
  const eventsByCompany = new Map<string, CompanyLifecycle[]>();
  for (const e of (events ?? []) as CompanyLifecycle[]) {
    const list = eventsByCompany.get(e.company_id) ?? [];
    list.push(e);
    eventsByCompany.set(e.company_id, list);
  }

  const portfolio: CompanyWithPortfolio[] = (companies ?? []).map((c) => ({
    id: c.id as string,
    name: c.name as string,
    tagline: c.tagline as string,
    thesis: (c.thesis as string | null) ?? null,
    target_segment: (c.target_segment as string | null) ?? null,
    funded_by: (c.funded_by as string | null) ?? null,
    funded_at: (c.funded_at as string | null) ?? null,
    active: (c.active as boolean) ?? true,
    color: c.color as string,
    latest_bet: latestBetByCompany.get(c.id as string) ?? null,
    recent_events: eventsByCompany.get(c.id as string)?.slice(0, 6) ?? [],
  }));

  const investorsWithCapital = ((investors ?? []) as InvestorAgent[]).map((inv) => ({
    ...inv,
    capital_balance: balanceByInvestor.get(inv.id) ?? 0,
  }));

  return NextResponse.json({
    investors: investorsWithCapital,
    portfolio,
  });
}
