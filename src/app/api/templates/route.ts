import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";

// The `templates` table is the legacy home of a special row named
// "pipeline_intro_prompt" that used to drive the AI intro sentence.
// Since migration 010/011, the authoritative source is
// `email_templates.intro_prompt` where name='global'. Both tables
// currently coexist (email-generator falls back to legacy `templates`
// if email_templates isn't seeded), so edits to the singleton prompt
// must mirror into the new table — otherwise the Templates UI looks
// like it's editing the prompt but drafts keep using the stale
// email_templates row. Only this one row gets mirrored; other
// templates stay single-homed.
const PIPELINE_PROMPT_NAME = "pipeline_intro_prompt";
async function mirrorIntroPromptToEmailTemplates(name: string, html: string): Promise<void> {
  if (name !== PIPELINE_PROMPT_NAME) return;
  try {
    await supabase
      .from("email_templates")
      .update({ intro_prompt: html, updated_at: new Date().toISOString() })
      .eq("name", "global");
  } catch {
    // email_templates may not be seeded yet — non-fatal.
  }
}

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

    await mirrorIntroPromptToEmailTemplates(name, html);
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

    // Mirror AFTER the update — we use the returned row's name + html
    // rather than the request body so we reflect what's actually in the
    // table (e.g. if only `html` was in the body but name was already
    // the prompt row, we still want to mirror).
    if (template?.name && typeof template?.html === "string") {
      await mirrorIntroPromptToEmailTemplates(template.name as string, template.html as string);
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
