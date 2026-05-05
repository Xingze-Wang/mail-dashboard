// POST /api/proposals/execute — admin triggers execution of an approved proposal.
// body: { proposal_id }
// Only admin can call. Writes to product tables happen here, never elsewhere.

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-helpers";
import { executeProposal } from "@/lib/proposals";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const body = await req.json().catch(() => ({}));
  if (!body.proposal_id) return NextResponse.json({ error: "proposal_id required" }, { status: 400 });

  const out = await executeProposal(body.proposal_id);
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: 400 });
  return NextResponse.json(out);
}
