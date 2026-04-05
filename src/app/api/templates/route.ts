import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";

export async function GET() {
  const { data: templates } = await supabase
    .from("templates")
    .select()
    .order("updated_at", { ascending: false });

  const mapped = (templates || []).map((t) => ({
    id: t.id,
    name: t.name,
    subject: t.subject,
    html: t.html,
    text: t.text,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  }));

  return NextResponse.json({ templates: mapped });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { name, subject, html, text } = body;

    if (!name || !subject || !html) {
      return NextResponse.json({ error: "Missing required fields: name, subject, html" }, { status: 400 });
    }

    const { data: template, error } = await supabase
      .from("templates")
      .insert({ name, subject, html, text: text || null })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(template, { status: 201 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to create template";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const { id, name, subject, html, text } = body;

    if (!id) {
      return NextResponse.json({ error: "Missing template id" }, { status: 400 });
    }

    const updates: Record<string, string | null> = { updated_at: new Date().toISOString() };
    if (name) updates.name = name;
    if (subject) updates.subject = subject;
    if (html) updates.html = html;
    if (text !== undefined) updates.text = text;

    const { data: template, error } = await supabase
      .from("templates")
      .update(updates)
      .eq("id", id)
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(template);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to update template";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json({ error: "Missing template id" }, { status: 400 });
    }

    const { error } = await supabase.from("templates").delete().eq("id", id);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ deleted: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to delete template";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
