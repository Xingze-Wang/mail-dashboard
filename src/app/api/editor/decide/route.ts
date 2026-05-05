// POST /api/editor/decide — admin decides on a pending appeal (uphold or deny).
// body: { appeal_id, decision: "upheld" | "denied", admin_note? }

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const body = await req.json().catch(() => ({}));
  if (!body.appeal_id || !body.decision || !["upheld", "denied"].includes(body.decision)) {
    return NextResponse.json({ error: "appeal_id and decision (upheld|denied) required" }, { status: 400 });
  }

  const { error } = await supabase
    .from("editor_appeals")
    .update({
      status: body.decision,
      decided_by: gate.session.repId,
      decided_at: new Date().toISOString(),
      admin_note: body.admin_note ?? null,
    })
    .eq("id", body.appeal_id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
