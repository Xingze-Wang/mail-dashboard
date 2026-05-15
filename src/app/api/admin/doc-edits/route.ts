import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * Doc-edit proposals — admin review surface (web).
 *
 * GET  /api/admin/doc-edits?status=pending  — list proposals
 * POST /api/admin/doc-edits                  — approve / reject / dismiss
 *
 * Both routes mirror the Lark text commands ("approve doc edit X" /
 * "reject doc edit X <reason>") so admin can work from either surface
 * with identical effect.
 */

export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const url = new URL(req.url);
  const status = ["pending", "approved", "rejected", "applied", "dismissed"].includes(url.searchParams.get("status") ?? "")
    ? url.searchParams.get("status")!
    : "pending";
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit")) || 30));

  const { data, error } = await supabase
    .from("doc_edit_proposals")
    .select("*")
    .eq("status", status)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Resolve proposer names for display.
  const proposerIds = [...new Set((data ?? []).map((d) => d.proposed_by_rep_id as number | null).filter((x): x is number => !!x))];
  const repNames = new Map<number, string>();
  if (proposerIds.length > 0) {
    const { data: reps } = await supabase
      .from("sales_reps")
      .select("id, name, sender_name")
      .in("id", proposerIds);
    for (const r of reps ?? []) {
      repNames.set(r.id as number, ((r.sender_name ?? r.name) as string));
    }
  }

  return NextResponse.json({
    status,
    count: (data ?? []).length,
    proposals: (data ?? []).map((d) => ({
      ...d,
      proposed_by_name: d.proposed_by_rep_id ? repNames.get(d.proposed_by_rep_id as number) ?? `rep#${d.proposed_by_rep_id}` : null,
    })),
  });
}

export async function POST(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    proposal_id?: string;
    action?: "approve" | "reject" | "dismiss";
    reason?: string;
    note?: string;
    apply_now?: boolean;
  };

  if (!body.proposal_id) return NextResponse.json({ error: "proposal_id required" }, { status: 400 });
  if (!body.action) return NextResponse.json({ error: "action required (approve|reject|dismiss)" }, { status: 400 });

  if (body.action === "approve") {
    const { approveDocEditProposal } = await import("@/lib/doc-edit-proposals");
    const r = await approveDocEditProposal({
      proposal_id: body.proposal_id,
      decided_by_rep_id: session.repId,
      decision_note: body.note ?? null,
      apply_now: body.apply_now !== false,
    });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 500 });
    return NextResponse.json({ ok: true, applied_steps: r.applied_steps });
  }

  if (body.action === "reject") {
    if (!body.reason || body.reason.trim().length < 10) {
      return NextResponse.json({ error: "reject reason ≥10 chars (becomes congress evidence)" }, { status: 400 });
    }
    const { rejectDocEditProposal } = await import("@/lib/doc-edit-proposals");
    const r = await rejectDocEditProposal({
      proposal_id: body.proposal_id,
      decided_by_rep_id: session.repId,
      reason: body.reason,
    });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "dismiss") {
    const { error } = await supabase
      .from("doc_edit_proposals")
      .update({
        status: "dismissed",
        decided_by_rep_id: session.repId,
        decided_at: new Date().toISOString(),
        decision_note: body.note ?? null,
      })
      .eq("id", body.proposal_id)
      .eq("status", "pending");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: `unknown action: ${body.action}` }, { status: 400 });
}
