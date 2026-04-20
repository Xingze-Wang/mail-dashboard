import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import {
  getAssignmentConfig,
  classifyLead,
  assignRep,
} from "@/lib/assignment";
import { requireAdmin } from "@/lib/auth-helpers";

export async function GET() {
  const config = await getAssignmentConfig();
  return NextResponse.json(config);
}

export async function PUT(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;
  const body = await req.json();

  if (!body.strong_criteria || !body.assignment) {
    return NextResponse.json(
      { error: "Must include strong_criteria and assignment" },
      { status: 400 },
    );
  }

  const { error } = await supabase
    .from("system_config")
    .upsert(
      {
        key: "lead_assignment",
        value: body,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" },
    );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, config: body });
}

/**
 * POST /api/config/assignment
 * Re-classify and re-assign EVERY existing lead with the current rules.
 * No body required. Returns counts of what changed.
 */
export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;
  const config = await getAssignmentConfig();

  const { data: leads, error: fetchError } = await supabase
    .from("pipeline_leads")
    .select(
      "id, citation_count, h_index, school_tier, author_email, matched_directions, lead_tier, assigned_rep_id",
    );

  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 500 });
  }

  const rows = leads ?? [];
  let reassigned = 0;
  let retiered = 0;
  let scanned = 0;
  const errors: string[] = [];

  for (const l of rows) {
    scanned++;
    const newTier = classifyLead(config, {
      citationCount: l.citation_count ?? null,
      hIndex: l.h_index ?? null,
      schoolTier: l.school_tier ?? null,
      authorEmail: l.author_email ?? "",
    });
    const newRepId = assignRep(config, newTier, l.author_email ?? "", l.matched_directions ?? null);

    const tierChanged = (l.lead_tier ?? "normal") !== newTier;
    const repChanged = (l.assigned_rep_id ?? null) !== newRepId;
    if (!tierChanged && !repChanged) continue;

    const { error: updateError } = await supabase
      .from("pipeline_leads")
      .update({ lead_tier: newTier, assigned_rep_id: newRepId })
      .eq("id", l.id);

    if (updateError) {
      errors.push(`${l.id}: ${updateError.message}`);
      continue;
    }
    if (tierChanged) retiered++;
    if (repChanged) reassigned++;
  }

  return NextResponse.json({
    ok: true,
    scanned,
    reassigned,
    retiered,
    errors: errors.length ? errors.slice(0, 10) : undefined,
  });
}
