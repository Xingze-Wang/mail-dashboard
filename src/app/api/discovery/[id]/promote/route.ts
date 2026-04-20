import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import {
  getAssignmentConfig,
  classifyLead,
  assignRep,
  getRep,
} from "@/lib/assignment";
import { normalizeSourceLabel } from "@/lib/sources";

/**
 * POST /api/discovery/[id]/promote
 *
 * Move a discovery_leads row (HF / Product Hunt / GitHub person-shaped lead)
 * into pipeline_leads so the existing classify → assign → send chain takes
 * over. The rep supplies the email address they just discovered/entered.
 *
 * Body (JSON):
 *   { email: string }
 *
 * Behavior:
 *   1. Look up discovery_leads by id. If already promoted → 409 with the
 *      existing pipeline_leads.id (looked up by author_email).
 *   2. Validate + normalize email (basic regex, lowercase, trim).
 *   3. Run getAssignmentConfig + classifyLead + assignRep.
 *   4. Insert into pipeline_leads with source = SOURCE_LABELS[code], status='new'.
 *   5. Stamp discovery_leads with promoted_at = now() and email = <input>.
 *   6. Return { success, pipelineLeadId, repId, repName, leadTier }.
 *
 * If migration 004 is not applied (discovery_leads or pipeline_leads is
 * missing) we return 503 with a clear message.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface DiscoveryRow {
  id: number;
  source: string;
  external_id: string;
  fullname: string | null;
  org: string | null;
  bio: string | null;
  email: string | null;
  promoted_at: string | null;
}

function isMissingTableError(msg: string | undefined, table: string): boolean {
  if (!msg) return false;
  const lower = msg.toLowerCase();
  return (
    lower.includes(`relation "${table}" does not exist`) ||
    lower.includes(`relation "public.${table}" does not exist`) ||
    (lower.includes(table) && lower.includes("does not exist"))
  );
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: rawId } = await ctx.params;
  const id = Number(rawId);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid discovery id" }, { status: 400 });
  }

  // Parse + validate body
  let body: { email?: unknown };
  try {
    body = (await req.json()) as { email?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const rawEmail = typeof body.email === "string" ? body.email : "";
  const email = rawEmail.trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email)) {
    return NextResponse.json(
      { error: "Valid email is required" },
      { status: 400 },
    );
  }

  // 1. Load the discovery row
  const { data: discRow, error: fetchErr } = await supabase
    .from("discovery_leads")
    .select("id, source, external_id, fullname, org, bio, email, promoted_at")
    .eq("id", id)
    .maybeSingle();

  if (fetchErr) {
    if (isMissingTableError(fetchErr.message, "discovery_leads")) {
      return NextResponse.json(
        {
          error:
            "discovery_leads table not found — apply migration 004 (POST /api/migrate/004-discovery)",
        },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  }
  if (!discRow) {
    return NextResponse.json({ error: "Discovery lead not found" }, { status: 404 });
  }

  const disc = discRow as DiscoveryRow;

  // Already promoted? Surface the existing pipeline row.
  if (disc.promoted_at) {
    const lookupEmail = (disc.email || email).trim().toLowerCase();
    let existingPipelineLeadId: string | null = null;
    if (lookupEmail) {
      const { data: existing } = await supabase
        .from("pipeline_leads")
        .select("id")
        .eq("author_email", lookupEmail)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      existingPipelineLeadId = (existing?.id as string | undefined) ?? null;
    }
    return NextResponse.json(
      { error: "Already promoted", existingPipelineLeadId },
      { status: 409 },
    );
  }

  // 2. Classify + assign. HF/PH/GH have no h-index/citation/school-tier info,
  //    so classification falls through to 'normal' and routing is decided
  //    purely by overseas vs .cn email domain.
  const config = await getAssignmentConfig();
  const leadTier = classifyLead(config, {
    citationCount: null,
    hIndex: null,
    schoolTier: null,
    authorEmail: email,
  });
  const repId = assignRep(config, leadTier, email);
  const rep = await getRep(repId);

  // 3. Insert into pipeline_leads.
  const sourceLabel = normalizeSourceLabel(disc.source);
  const authorName = disc.fullname || disc.external_id;
  const bioSnippet = (disc.bio || "").trim().slice(0, 80);
  const titleTail = bioSnippet || disc.external_id;
  const title = `Discovered on ${sourceLabel} — ${titleTail}`;
  // pipeline_leads.arxiv_id is unique + non-null in legacy rows; synthesise a
  // stable-ish id mirroring the manual-import pattern in /api/pipeline/import.
  const arxivId = `${disc.source}_${disc.id}_${Date.now().toString(36)}`;

  const { data: inserted, error: insertErr } = await supabase
    .from("pipeline_leads")
    .insert({
      arxiv_id: arxivId,
      title,
      abstract: disc.bio || "",
      author_name: authorName,
      author_email: email,
      school_name: disc.org,
      status: "new",
      source: sourceLabel,
      lead_tier: leadTier,
      assigned_rep_id: repId,
    })
    .select("id")
    .single();

  if (insertErr) {
    if (isMissingTableError(insertErr.message, "pipeline_leads")) {
      return NextResponse.json(
        {
          error:
            "pipeline_leads table not found — apply the base migration before promoting",
        },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: insertErr.message }, { status: 500 });
  }

  const pipelineLeadId = (inserted?.id as string | undefined) ?? null;

  // 4. Stamp the discovery row so it disappears from the discovery list.
  const { error: updErr } = await supabase
    .from("discovery_leads")
    .update({ promoted_at: new Date().toISOString(), email })
    .eq("id", id);

  if (updErr) {
    // Non-fatal: pipeline_leads insert succeeded. Surface the warning so the
    // UI can still toast success but log the inconsistency.
    return NextResponse.json({
      success: true,
      pipelineLeadId,
      repId,
      repName: rep?.name ?? null,
      leadTier,
      warning: `Promoted, but failed to stamp discovery_leads: ${updErr.message}`,
    });
  }

  return NextResponse.json({
    success: true,
    pipelineLeadId,
    repId,
    repName: rep?.name ?? null,
    leadTier,
  });
}
