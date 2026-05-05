// GET  /api/proposals      → admin queue + per-state counts
// POST /api/proposals      → submit a new proposal (auto-runs editor gate)

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";
import { submitProposal, type ProposalKind } from "@/lib/proposals";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const url = new URL(req.url);
  const stateFilter = url.searchParams.get("state");

  let q = supabase
    .from("company_proposals")
    .select("*, company:bench_companies(name, color), editor_review:editor_reviews(verdict, feedback)")
    .order("created_at", { ascending: false })
    .limit(100);
  if (stateFilter) q = q.eq("state", stateFilter);
  const { data } = await q;

  // Per-state counts for queue health.
  const { data: counts } = await supabase
    .from("company_proposals")
    .select("state");
  const byState: Record<string, number> = {};
  for (const r of counts ?? []) byState[r.state as string] = (byState[r.state as string] ?? 0) + 1;

  return NextResponse.json({
    proposals: data ?? [],
    counts_by_state: byState,
  });
}

export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const body = await req.json().catch(() => ({}));
  if (!body.company_id || !body.kind || !body.payload) {
    return NextResponse.json({ error: "company_id, kind, payload required" }, { status: 400 });
  }

  const out = await submitProposal({
    company_id: body.company_id,
    contract_id: body.contract_id ?? null,
    investor_id: body.investor_id ?? null,
    kind: body.kind as ProposalKind,
    payload: body.payload,
    affected_targets: body.affected_targets ?? {},
    prediction: body.prediction ?? "",
  });
  if ("error" in out) return NextResponse.json({ error: out.error }, { status: 400 });
  return NextResponse.json(out);
}
