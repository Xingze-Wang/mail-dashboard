// GET /api/admin/tasks/<id> — fetch a single guided_task row for the UI.
// Admin-only. Used by the /admin/intent live view to poll task state.
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

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdmin(req))) return NextResponse.json({ error: "admin only" }, { status: 403 });
  const { id } = await params;
  const { getGuidedTask } = await import("@/lib/guided-tasks");
  const task = await getGuidedTask(id);
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ task });
}
