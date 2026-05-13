import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { supabase } from "@/lib/db";

export const dynamic = "force-dynamic";

/** GET: list pending + recent decided candidate inbox rows. */
export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "admin only" }, { status: 403 });
  }

  const pending = await supabase
    .from("admin_inbox")
    .select("id, kind, headline, body, evidence, status, created_at")
    .eq("kind", "candidate_global_template")
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const decided = await supabase
    .from("admin_inbox")
    .select("id, kind, headline, status, created_at")
    .eq("kind", "candidate_global_template")
    .neq("status", "pending")
    .gte("created_at", since)
    .order("created_at", { ascending: false });

  return NextResponse.json({
    pending: pending.data || [],
    decided: decided.data || [],
  });
}

/** POST: approve OR reject a candidate.
 *  Body: { inbox_id, action: 'approve' | 'reject' }
 */
export async function POST(req: NextRequest) {
  const session = await requireSession(req);
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "admin only" }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  const inboxId = body.inbox_id as string;
  const action = body.action as "approve" | "reject";
  if (!inboxId || !["approve", "reject"].includes(action)) {
    return NextResponse.json({ error: "inbox_id + action required" }, { status: 400 });
  }

  const row = await supabase
    .from("admin_inbox")
    .select("id, evidence, status")
    .eq("id", inboxId)
    .maybeSingle();
  if (!row.data) {
    return NextResponse.json({ error: "inbox row not found" }, { status: 404 });
  }
  if (row.data.status !== "pending") {
    return NextResponse.json({ error: "already decided" }, { status: 409 });
  }

  const evidence = row.data.evidence as {
    per_rep_template_id?: string;
  } | null;

  if (action === "reject") {
    await supabase
      .from("admin_inbox")
      .update({ status: "dismissed", decided_by_rep_id: session.repId })
      .eq("id", inboxId);
    return NextResponse.json({ ok: true, action: "rejected" });
  }

  if (!evidence?.per_rep_template_id) {
    return NextResponse.json({ error: "evidence missing per_rep_template_id" }, { status: 400 });
  }
  const src = await supabase
    .from("email_templates")
    .select("*")
    .eq("id", evidence.per_rep_template_id)
    .maybeSingle();
  if (!src.data) {
    return NextResponse.json({ error: "source per-rep template not found" }, { status: 404 });
  }

  const clone = {
    name: `${src.data.name} (proposed global)`,
    rep_id: null,
    active: false,
    status: "proposal",
    proposed_by: "admin_from_rep_edit",
    proposed_reason: `Promoted by admin from per-rep template ${src.data.id}. Original evidence: ${JSON.stringify(src.data.proposed_evidence)}`,
    proposed_evidence: { ...(src.data.proposed_evidence as Record<string, unknown>), promoted_from: src.data.id, promoted_by: session.repId, promoted_at: new Date().toISOString() },
    subject_format: src.data.subject_format,
    intro_prompt: src.data.intro_prompt,
    greeting_format: src.data.greeting_format,
    rep_intro_format: src.data.rep_intro_format,
    school_pitch_format: src.data.school_pitch_format,
    cta_signoff_format: src.data.cta_signoff_format,
    notes: src.data.notes,
    full_html_override: src.data.full_html_override,
    subject_override: src.data.subject_override,
  };

  const ins = await supabase.from("email_templates").insert(clone).select("id").maybeSingle();
  if (ins.error) {
    return NextResponse.json({ error: ins.error.message }, { status: 500 });
  }

  await supabase
    .from("admin_inbox")
    .update({ status: "approved", decided_by_rep_id: session.repId })
    .eq("id", inboxId);

  return NextResponse.json({
    ok: true,
    action: "approved",
    new_proposal_template_id: ins.data?.id,
  });
}
