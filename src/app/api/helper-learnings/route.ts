import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { loadActiveLearnings, recordLearning, supersedeLearning, type LearningKind } from "@/lib/helper-learnings";

export const dynamic = "force-dynamic";

/**
 * GET /api/helper-learnings?repId=<id>
 * Returns active learnings for the rep (org-wide always included).
 *
 * POST /api/helper-learnings
 * Body: { kind, body, scope_rep_id?, evidence?, confidence? }
 * Records a new learning. Sales reps can only write rep-scoped learnings
 * for themselves; admin can write any scope.
 *
 * DELETE /api/helper-learnings?id=<uuid>
 * Marks a learning as superseded (not hard-deleted, for audit trail).
 */
export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const queryRepId = url.searchParams.get("repId");
  let repId: number | null = session.repId;
  if (session.role === "admin" && queryRepId) {
    if (queryRepId === "null") repId = null;
    else {
      const parsed = Number(queryRepId);
      if (Number.isFinite(parsed)) repId = parsed;
    }
  }

  const learnings = await loadActiveLearnings(repId, 50);
  return NextResponse.json({ learnings });
}

export async function POST(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const kind = body.kind as LearningKind;
  const text = body.body as string;
  if (!kind || !text || typeof text !== "string" || text.trim().length === 0) {
    return NextResponse.json({ error: "Missing kind or body" }, { status: 400 });
  }
  if (!["rep_pref", "tactic", "self_critique", "other"].includes(kind)) {
    return NextResponse.json({ error: "Invalid kind" }, { status: 400 });
  }

  // Sales can only write learnings scoped to themselves; admin can pick any.
  let scopeRepId: number | null = session.repId;
  if (session.role === "admin" && body.scope_rep_id !== undefined) {
    scopeRepId = body.scope_rep_id === null ? null : Number(body.scope_rep_id);
  }

  const learning = await recordLearning({
    scope_rep_id: scopeRepId,
    kind,
    body: text,
    evidence: body.evidence ?? null,
    confidence: typeof body.confidence === "number" ? body.confidence : 0.5,
  });
  if (!learning) return NextResponse.json({ error: "Insert failed" }, { status: 500 });
  return NextResponse.json({ learning });
}

export async function DELETE(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const ok = await supersedeLearning(id);
  if (!ok) return NextResponse.json({ error: "Update failed" }, { status: 500 });
  return NextResponse.json({ ok: true });
}
