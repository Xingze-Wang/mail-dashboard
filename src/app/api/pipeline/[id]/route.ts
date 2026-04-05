import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";

function mapLead(l: Record<string, unknown>) {
  return {
    id: l.id,
    arxivId: l.arxiv_id,
    title: l.title,
    abstract: l.abstract,
    authors: l.authors,
    pdfUrl: l.pdf_url,
    publishedAt: l.published_at,
    authorName: l.author_name,
    authorEmail: l.author_email,
    firstName: l.first_name,
    schoolName: l.school_name,
    schoolTier: l.school_tier,
    computeLevel: l.compute_level,
    computeConfidence: l.compute_confidence,
    computeReason: l.compute_reason,
    matchedDirections: l.matched_directions,
    draftSubject: l.draft_subject,
    draftHtml: l.draft_html,
    status: l.status,
    sentAt: l.sent_at,
    createdAt: l.created_at,
  };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const { data: lead } = await supabase
    .from("pipeline_leads")
    .select("*")
    .eq("id", id)
    .single();

  if (!lead) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(mapLead(lead));
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const body = await req.json();
    const { status, draftSubject, draftHtml } = body;

    const updates: Record<string, unknown> = {};
    if (status !== undefined) updates.status = status;
    if (draftSubject !== undefined) updates.draft_subject = draftSubject;
    if (draftHtml !== undefined) updates.draft_html = draftHtml;

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400 });
    }

    const { data: lead, error } = await supabase
      .from("pipeline_leads")
      .update(updates)
      .eq("id", id)
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!lead) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json(mapLead(lead));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to update lead";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const { error } = await supabase
    .from("pipeline_leads")
    .delete()
    .eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ deleted: true });
}
