import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * POST /api/lead/switch-author
 * Body: { leadId: string, newAuthorName: string, newAuthorEmail?: string }
 *
 * Re-targets a lead from one author to another (typically last-author → first-
 * author when sales spots that we should be emailing the PhD student instead
 * of the PI). Logs the switch as a lead_corrections row of type 'wrong_author'
 * so the training pipeline learns from it.
 *
 * The draft is left as-is — sales should hit "Regenerate" in the brief or
 * Review pane after switching, OR can just edit the textarea before sending.
 * We don't auto-regenerate here because LLM call adds latency and most
 * intros use first-name only ("Xiaoguang 你好") — switching by email
 * usually means the body doesn't actually need a rewrite.
 */
export async function POST(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const leadId = String(body.leadId ?? "").trim();
  const newAuthorName = String(body.newAuthorName ?? "").trim();
  const newAuthorEmail = body.newAuthorEmail
    ? String(body.newAuthorEmail).trim().toLowerCase()
    : null;

  if (!leadId || !newAuthorName) {
    return NextResponse.json({ error: "leadId + newAuthorName required" }, { status: 400 });
  }

  // Ownership — non-privileged users can only switch-author their own leads.
  const isPrivileged = session.role === "admin" || session.role === "senior";
  const { data: ownerCheck } = await supabase
    .from("pipeline_leads")
    .select("assigned_rep_id")
    .eq("id", leadId)
    .maybeSingle();
  if (!ownerCheck) return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  if (!isPrivileged && ownerCheck.assigned_rep_id !== session.repId) {
    return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  }

  const { data: lead, error: fetchErr } = await supabase
    .from("pipeline_leads")
    .select("id, author_name, author_email, first_name")
    .eq("id", leadId)
    .maybeSingle();
  if (fetchErr || !lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });

  // Derive a first_name from the new author for the greeting line.
  // Heuristic: split on whitespace, take first part. Works for both
  // "Chongjie Ye" → "Chongjie" and "ZHANG San" → "ZHANG".
  const newFirstName = newAuthorName.split(/\s+/)[0] || newAuthorName;

  const updates: Record<string, unknown> = {
    author_name: newAuthorName,
    first_name: newFirstName,
  };
  if (newAuthorEmail) updates.author_email = newAuthorEmail;

  // Reset enrichment that was tied to the old author — citation/h-index
  // belonged to the previous person. Backfill route or next draft-queue
  // pass will re-enrich for the new one.
  updates.citation_count = null;
  updates.h_index = null;
  updates.s2_author_id = null;
  updates.paper_count = null;

  const { error: updErr } = await supabase
    .from("pipeline_leads")
    .update(updates)
    .eq("id", leadId);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  // Log the switch — this is a training signal, the original assignment
  // was wrong. Don't fail the request if the audit insert errors (table
  // may not exist yet on dev).
  await supabase
    .from("lead_corrections")
    .insert({
      lead_id: leadId,
      type: "wrong_author",
      reason: `Switched recipient: ${lead.author_name} → ${newAuthorName}`,
      payload: {
        from_name: lead.author_name,
        from_email: lead.author_email,
        to_name: newAuthorName,
        to_email: newAuthorEmail,
      },
      corrected_by: session.email,
    })
    .then(() => {}, () => { /* ignore */ });

  return NextResponse.json({ ok: true, newAuthorName, newAuthorEmail, newFirstName });
}
