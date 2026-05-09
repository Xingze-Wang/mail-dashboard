import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";
import { assembleDraft, type EmailTemplate } from "@/lib/template-assembler";

export const maxDuration = 60;

/**
 * GET /api/templates/[id]/inspect?lead_id=<uuid>
 *
 * Renders one template against one real lead AND returns the per-part
 * provenance. Used by /templates/[id]/inspect to show "this paragraph
 * came from THIS rule / THIS prompt".
 *
 * If lead_id is missing, picks the most-recent assigned-pipeline lead
 * (any segment) so the inspector loads with something to look at.
 *
 * Auth: admin only.
 */
async function requireAdmin(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return null;
  const { data: rep } = await supabase
    .from("sales_reps")
    .select("role")
    .eq("id", session.repId)
    .maybeSingle();
  if (!rep || rep.role !== "admin") return null;
  return session;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const { id } = await params;
  const url = new URL(req.url);
  const leadId = url.searchParams.get("lead_id");

  const { data: tpl } = await supabase
    .from("email_templates")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!tpl) return NextResponse.json({ error: "Template not found" }, { status: 404 });

  let leadRow;
  if (leadId) {
    const { data } = await supabase
      .from("pipeline_leads")
      .select(
        "id, title, abstract, author_email, first_name, school_name, school_tier, matched_directions, assigned_rep_id",
      )
      .eq("id", leadId)
      .maybeSingle();
    leadRow = data;
  } else {
    const { data } = await supabase
      .from("pipeline_leads")
      .select(
        "id, title, abstract, author_email, first_name, school_name, school_tier, matched_directions, assigned_rep_id",
      )
      .not("assigned_rep_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    leadRow = data;
  }
  if (!leadRow) return NextResponse.json({ error: "No lead available" }, { status: 404 });

  // Resolve rep for repName/repWechat (so the rendered output shows
  // realistic identity strings, not placeholders).
  let repName = "Leon";
  let repWechat = "";
  if (leadRow.assigned_rep_id) {
    const { data: rep } = await supabase
      .from("sales_reps")
      .select("sender_name, name, wechat_id")
      .eq("id", leadRow.assigned_rep_id)
      .maybeSingle();
    if (rep) {
      repName = (rep.sender_name as string | null) ?? (rep.name as string | null) ?? "Leon";
      repWechat = (rep.wechat_id as string | null) ?? "";
    }
  }

  const draft = await assembleDraft(tpl as EmailTemplate, {
    title: leadRow.title,
    abstract: leadRow.abstract,
    authorEmail: leadRow.author_email,
    firstName: leadRow.first_name,
    schoolName: leadRow.school_name,
    schoolTier: leadRow.school_tier,
    matchedDirections: Array.isArray(leadRow.matched_directions)
      ? leadRow.matched_directions
      : [],
    repName,
    repWechatId: repWechat,
  });

  return NextResponse.json({
    template: {
      id: tpl.id,
      name: tpl.name,
      status: tpl.status,
      segment_default: tpl.segment_default,
    },
    lead: {
      id: leadRow.id,
      title: leadRow.title,
      author_email: leadRow.author_email,
      first_name: leadRow.first_name,
      school_name: leadRow.school_name,
      school_tier: leadRow.school_tier,
      matched_directions: leadRow.matched_directions,
    },
    rendered: { subject: draft.subject, html: draft.html },
    parts: draft.parts,
    intro_prompt_resolved: draft.introPromptResolved,
    intro_output: draft.introOutput,
  });
}
