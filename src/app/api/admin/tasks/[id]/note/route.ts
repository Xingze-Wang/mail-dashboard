// POST /api/admin/tasks/<id>/note { step_index, text }
// Admin attaches a free-text note to a step (visible to Leon, useful
// for course-correction before approving).
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

async function isAdmin(req: NextRequest): Promise<boolean> {
  const session = await requireSession(req);
  if (!session) return false;
  const { data: rep } = await supabase
    .from("sales_reps")
    .select("role")
    .eq("id", session.repId)
    .maybeSingle();
  return rep?.role === "admin";
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdmin(req))) return NextResponse.json({ error: "admin only" }, { status: 403 });
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { step_index?: number; text?: string };
  if (typeof body.step_index !== "number" || !body.text) {
    return NextResponse.json({ error: "step_index + text required" }, { status: 400 });
  }
  const { addAdminNote } = await import("@/lib/guided-tasks");
  const r = await addAdminNote({ task_id: id, step_index: body.step_index, text: body.text });
  return NextResponse.json(r);
}
