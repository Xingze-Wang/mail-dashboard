import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * GET    /api/help/conversations/[id]      — messages in a thread
 * PATCH  /api/help/conversations/[id]      — rename or archive
 * DELETE /api/help/conversations/[id]      — permanently delete (cascades messages)
 *
 * Ownership: rep_id must match session.repId (or session.role === 'admin').
 */

async function loadAndAuthorize(id: string, session: { repId: number; role: string }) {
  const { data: conv } = await supabase
    .from("helper_conversations")
    .select("id, rep_id, mode, title, lead_id, archived, created_at, updated_at")
    .eq("id", id)
    .maybeSingle();
  if (!conv) return { ok: false, status: 404, error: "Not found" };
  const isAdmin = session.role === "admin";
  if (!isAdmin && conv.rep_id !== session.repId) {
    // 404 (not 403) to avoid id leaks.
    return { ok: false, status: 404, error: "Not found" };
  }
  return { ok: true, conv };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const gate = await loadAndAuthorize(id, session);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

  const { data: messages, error } = await supabase
    .from("helper_messages")
    .select("id, role, text, tool_proposal, tool_result, created_at")
    .eq("conversation_id", id)
    .order("created_at", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ conversation: gate.conv, messages: messages ?? [] });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const gate = await loadAndAuthorize(id, session);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

  const body = await req.json().catch(() => ({}));
  const updates: Record<string, unknown> = {};
  if (typeof body.title === "string") updates.title = body.title.slice(0, 120);
  if (typeof body.archived === "boolean") updates.archived = body.archived;
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }
  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from("helper_conversations")
    .update(updates)
    .eq("id", id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ conversation: data });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const gate = await loadAndAuthorize(id, session);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

  const { error } = await supabase.from("helper_conversations").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ deleted: true });
}
