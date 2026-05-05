// POST /api/mapping/drafts/decide
// body: { draft_id, decision: "approve" | "reject" | "edit_and_approve",
//         edited_subject?, edited_body_html?, reject_reason? }
//
// Calls decideDraft which (a) updates mapping_drafts and (b) on approve
// writes the (possibly-edited) draft back to pipeline_leads.draft_html.

import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { decideDraft } from "@/lib/mapping";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  if (!body.draft_id || !body.decision) {
    return NextResponse.json({ error: "draft_id, decision required" }, { status: 400 });
  }
  if (!["approve", "reject", "edit_and_approve"].includes(body.decision)) {
    return NextResponse.json({ error: "decision must be approve|reject|edit_and_approve" }, { status: 400 });
  }

  const r = await decideDraft({
    draft_id: body.draft_id,
    decision: body.decision,
    decided_by: session.repId,
    edited_subject: body.edited_subject,
    edited_body_html: body.edited_body_html,
    reject_reason: body.reject_reason,
  });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}
