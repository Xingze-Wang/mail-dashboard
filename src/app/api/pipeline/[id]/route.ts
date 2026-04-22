import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin, requireSession } from "@/lib/auth-helpers";

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
    s2AuthorId: l.s2_author_id,
    hIndex: l.h_index,
    citationCount: l.citation_count,
    paperCount: l.paper_count,
    leadTier: l.lead_tier,
    assignedRepId: l.assigned_rep_id,
  };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  const { data: lead } = await supabase
    .from("pipeline_leads")
    .select("*")
    .eq("id", id)
    .single();

  if (!lead) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Ownership — non-privileged reps only see their own leads. 404 to
  // avoid leaking which ids exist.
  const isPrivileged = session.role === "admin" || session.role === "senior";
  if (!isPrivileged && lead.assigned_rep_id !== session.repId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(mapLead(lead));
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  // Ownership lookup.
  const { data: existing } = await supabase
    .from("pipeline_leads")
    .select("assigned_rep_id")
    .eq("id", id)
    .single();
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const isPrivileged = session.role === "admin" || session.role === "senior";
  if (!isPrivileged && existing.assigned_rep_id !== session.repId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const body = await req.json();
    const { status, draftSubject, draftHtml, assignedRepId, leadTier } = body;

    const updates: Record<string, unknown> = {};
    if (status !== undefined) updates.status = status;
    if (draftSubject !== undefined) updates.draft_subject = draftSubject;
    if (draftHtml !== undefined) updates.draft_html = draftHtml;
    // Only admin/senior can change assignment. A sales rep could
    // otherwise re-assign a lead to themselves. Silently drop the field.
    if (assignedRepId !== undefined && isPrivileged) updates.assigned_rep_id = assignedRepId;
    // Only admin/senior can change tier (strong vs normal affects assignment).
    if (leadTier !== undefined && isPrivileged) updates.lead_tier = leadTier;

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
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;
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
