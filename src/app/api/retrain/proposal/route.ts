import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-helpers";
import { supabase } from "@/lib/db";
import { buildProposal, decideProposal, emitRetrainSignals } from "@/lib/retrain-signals";

export const dynamic = "force-dynamic";

/**
 * GET /api/retrain/proposal
 * Returns the current pending proposal (if any) plus pending signals.
 *
 * POST /api/retrain/proposal
 * Forces signal emission + proposal build. Returns the new proposal or
 * null if nothing pending. Admin-triggered; the cron will also call this.
 *
 * PATCH /api/retrain/proposal { id, decision: "approved" | "rejected" }
 * Records the admin's decision and (if approved) consumes the underlying signals.
 * Approval does NOT auto-trigger /api/scorer/conversion-model — admin still
 * has to click that. v1 keeps human-in-the-loop on the actual training step.
 */

export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const { data: pending } = await supabase
    .from("retrain_proposals")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(1);
  const { data: signals } = await supabase
    .from("retrain_signals")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  return NextResponse.json({
    proposal: pending?.[0] ?? null,
    pendingSignals: signals ?? [],
  });
}

export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const emit = await emitRetrainSignals();
  const proposal = await buildProposal();
  return NextResponse.json({ ok: true, signalsEmitted: emit.emitted, proposal });
}

export async function PATCH(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const body = await req.json();
  const id = body.id as string;
  const decision = body.decision as "approved" | "rejected";
  if (!id || (decision !== "approved" && decision !== "rejected")) {
    return NextResponse.json({ error: "Missing id or invalid decision" }, { status: 400 });
  }
  const ok = await decideProposal(id, decision, gate.session.email);
  if (!ok) return NextResponse.json({ error: "Decision failed" }, { status: 500 });
  return NextResponse.json({ ok: true });
}
