// POST /api/proposals/decide — admin approves or rejects a proposal in admin_review.
// body: { proposal_id, decision: "approved" | "rejected" | "deferred", note? }

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-helpers";
import { decideProposal } from "@/lib/proposals";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const body = await req.json().catch(() => ({}));
  if (!body.proposal_id || !body.decision) {
    return NextResponse.json({ error: "proposal_id, decision required" }, { status: 400 });
  }

  const out = await decideProposal({
    proposal_id: body.proposal_id,
    decision: body.decision,
    admin_rep_id: gate.session.repId,
    note: body.note,
  });
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: 400 });
  return NextResponse.json(out);
}
