import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";
import { getRep } from "@/lib/assignment";

/**
 * PATCH /api/inbound/:id
 *
 * Update a single inbound email — currently used to flip `is_read`.
 * Body: { isRead?: boolean }
 *
 * Per-rep scoping: sales can only update inbounds in threads they
 * originated. Admin + senior unrestricted. We resolve the row's
 * thread_id, find the original outbound sender, and check ownership.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    // Auth required up front. Previously a null session skipped the
    // ownership check and the PATCH proceeded on any inbound row.
    const session = await requireSession(req);
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { isRead } = body as { isRead?: boolean };

    const updates: Record<string, unknown> = {};
    if (typeof isRead === "boolean") updates.is_read = isRead;

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400 });
    }

    // Ownership check (only for sales role).
    const isPrivileged = session.role === "admin" || session.role === "senior";
    if (!isPrivileged) {
      const rep = await getRep(session.repId);
      if (!rep?.sender_email) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      const { data: inbound } = await supabase
        .from("inbound_emails")
        .select("thread_id")
        .eq("id", id)
        .maybeSingle();
      if (!inbound?.thread_id) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      const { data: outbound } = await supabase
        .from("emails")
        .select("from")
        .eq("thread_id", inbound.thread_id)
        .ilike("from", `%${rep.sender_email}%`)
        .limit(1);
      if (!outbound || outbound.length === 0) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
    }

    const { data, error } = await supabase
      .from("inbound_emails")
      .update(updates)
      .eq("id", id)
      .select("id, is_read")
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!data) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ id: data.id, isRead: data.is_read });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to update inbound email";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
