import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";

/**
 * PATCH /api/inbound/:id
 *
 * Update a single inbound email — currently used to flip `is_read`.
 * Body: { isRead?: boolean }
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const body = await req.json().catch(() => ({}));
    const { isRead } = body as { isRead?: boolean };

    const updates: Record<string, unknown> = {};
    if (typeof isRead === "boolean") updates.is_read = isRead;

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400 });
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
