import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/template-edits
 *   ?status=pending|approved|rejected|superseded|all  (default 'pending')
 *   ?template_id=<uuid>  (optional, scope to one template)
 *
 * Lists template_edits rows for the admin review queue. Joins the
 * submitter's name and the template's name for display. Sorted by
 * submitted_at descending (newest first).
 *
 * Auth: admin only — non-admins shouldn't see other reps' submissions.
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

interface EditRow {
  id: string;
  template_id: string;
  slot_key: string;
  old_value: string | null;
  new_value: string | null;
  gate_verdict: string | null;
  gate_annotations: Record<string, unknown> | null;
  status: string;
  submitted_by_rep_id: number;
  submitted_at: string;
  reviewed_by_rep_id: number | null;
  reviewed_at: string | null;
  review_note: string | null;
  rep_rationale: string | null;
}

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? "pending";
  const templateId = url.searchParams.get("template_id");

  let q = supabase
    .from("template_edits")
    .select(
      "id, template_id, slot_key, old_value, new_value, gate_verdict, gate_annotations, status, submitted_by_rep_id, submitted_at, reviewed_by_rep_id, reviewed_at, review_note, rep_rationale",
    )
    .order("submitted_at", { ascending: false })
    .limit(200);

  if (status !== "all") q = q.eq("status", status);
  if (templateId) q = q.eq("template_id", templateId);

  const { data: edits, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (edits ?? []) as EditRow[];

  // Resolve submitter + template names in two batched queries.
  const repIds = Array.from(new Set(rows.map((r) => r.submitted_by_rep_id)));
  const tplIds = Array.from(new Set(rows.map((r) => r.template_id)));

  const repNames = new Map<number, string>();
  if (repIds.length > 0) {
    const { data } = await supabase
      .from("sales_reps")
      .select("id, sender_name, name")
      .in("id", repIds);
    for (const r of data ?? []) {
      repNames.set(r.id as number, ((r.sender_name as string | null) ?? (r.name as string | null) ?? `rep#${r.id}`));
    }
  }

  const tplMeta = new Map<string, { name: string; status: string }>();
  if (tplIds.length > 0) {
    const { data } = await supabase
      .from("email_templates")
      .select("id, name, status")
      .in("id", tplIds);
    for (const t of data ?? []) {
      tplMeta.set(t.id as string, { name: t.name as string, status: t.status as string });
    }
  }

  const enriched = rows.map((r) => ({
    ...r,
    submitter_name: repNames.get(r.submitted_by_rep_id) ?? `rep#${r.submitted_by_rep_id}`,
    template_name: tplMeta.get(r.template_id)?.name ?? "(unknown)",
    template_status: tplMeta.get(r.template_id)?.status ?? "?",
  }));

  return NextResponse.json({ edits: enriched, count: enriched.length });
}
