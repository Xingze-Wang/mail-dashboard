// POST /api/admin/tasks/<id>/ack { ack: "continue"|"aborted"|"modified" }
// Admin-only. Used by the live view's ✓ Approve / ✗ Abort buttons.
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

async function getAdminRepId(req: NextRequest): Promise<number | null> {
  const session = await requireSession(req);
  if (!session) return null;
  const { data: rep } = await supabase
    .from("sales_reps")
    .select("role")
    .eq("id", session.repId)
    .maybeSingle();
  if (rep?.role !== "admin") return null;
  return session.repId;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const repId = await getAdminRepId(req);
  if (repId == null) return NextResponse.json({ error: "admin only" }, { status: 403 });
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { ack?: string; abort_reason?: string };
  const ack = body.ack ?? "";
  if (!["continue", "aborted", "modified"].includes(ack)) {
    return NextResponse.json({ error: "ack must be continue|aborted|modified" }, { status: 400 });
  }
  const { ackGuidedStep } = await import("@/lib/guided-tasks");
  const r = await ackGuidedStep({
    task_id: id,
    ack: ack as "continue" | "aborted" | "modified",
    abort_reason: body.abort_reason,
  });
  return NextResponse.json(r);
}
