import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET() {
  const templates = await prisma.template.findMany({
    orderBy: { updatedAt: "desc" },
  });
  return NextResponse.json({ templates });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { name, subject, html, text } = body;

    if (!name || !subject || !html) {
      return NextResponse.json({ error: "Missing required fields: name, subject, html" }, { status: 400 });
    }

    const template = await prisma.template.create({
      data: { name, subject, html, text: text || null },
    });

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

    const template = await prisma.template.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(subject && { subject }),
        ...(html && { html }),
        ...(text !== undefined && { text }),
      },
    });

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

    await prisma.template.delete({ where: { id } });
    return NextResponse.json({ deleted: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to delete template";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
