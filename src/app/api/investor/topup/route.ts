// POST /api/investor/topup — adds capital to an investor's pool.
// body: { investor_id, amount, note? }

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const body = await req.json().catch(() => ({}));
  if (!body.investor_id || !body.amount) {
    return NextResponse.json({ error: "investor_id, amount required" }, { status: 400 });
  }

  const { data: latest } = await supabase
    .from("investor_capital_ledger")
    .select("balance_after")
    .eq("investor_id", body.investor_id)
    .order("occurred_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const balance = Number(latest?.balance_after ?? 0);
  const newBalance = balance + Number(body.amount);

  await supabase.from("investor_capital_ledger").insert({
    investor_id: body.investor_id,
    kind: "pool_topup",
    delta: Number(body.amount),
    balance_after: newBalance,
    note: body.note ?? "Manual topup",
  });

  return NextResponse.json({ ok: true, new_balance: newBalance });
}
