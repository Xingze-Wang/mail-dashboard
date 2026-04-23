import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * GET  /api/help/conversations           — list current rep's threads
 * POST /api/help/conversations           — start a new thread
 *   body: { mode: 'sales'|'paper', leadId?: string, title?: string }
 *
 * Thread ownership: rep_id must match the session's repId. Admin sees
 * everyone's (for support/debugging); regular sales sees only their
 * own.
 */
export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const isAdmin = session.role === "admin";
  const url = new URL(req.url);
  const includeArchived = url.searchParams.get("archived") === "1";

  let q = supabase
    .from("helper_conversations")
    .select("id, rep_id, mode, title, lead_id, created_at, updated_at, archived")
    .order("updated_at", { ascending: false })
    .limit(50);
  if (!includeArchived) q = q.eq("archived", false);
  if (!isAdmin) q = q.eq("rep_id", session.repId);

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ conversations: data ?? [] });
}

export async function POST(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const mode = body.mode === "paper" ? "paper" : "sales";
  const leadId = typeof body.leadId === "string" ? body.leadId : null;
  const title = typeof body.title === "string" ? body.title.slice(0, 120) : null;

  const { data, error } = await supabase
    .from("helper_conversations")
    .insert({ rep_id: session.repId, mode, lead_id: leadId, title })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ conversation: data });
}
