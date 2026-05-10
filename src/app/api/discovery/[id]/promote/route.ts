import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import {
  getAssignmentConfig,
  classifyLead,
  assignRep,
  getRep,
} from "@/lib/assignment";
import { normalizeSourceLabel } from "@/lib/sources";
import { scoreWithGemini } from "@/lib/gemini-scorer";
import { requireSession } from "@/lib/auth-helpers";
import { resolvePerson } from "@/lib/person-resolver";

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
  // Must be an authenticated user. Previously unauthed callers could
  // promote any discovery row into pipeline_leads with an attacker-
  // chosen email — those would later be drafted + sent real outreach.
  const session = await requireSession(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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

  // Already-promoted fast path: if the row was already stamped before
  // we even read it, surface the existing pipeline lead. The slow path
  // (race between two near-simultaneous POSTs) is handled below by a
  // conditional UPDATE that wins exactly once.
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

  // RACE GUARD: claim the discovery row with a single conditional
  // UPDATE before doing any of the expensive work below. If two
  // requests arrive within milliseconds of each other, both saw
  // promoted_at=NULL above — but only one of them can flip it to
  // non-null with this WHERE-clause-gated update, and PostgREST
  // returns the matched row(s) via .select(). An empty array means
  // we lost the race; the other request is already past this point.
  // This replaces the read-then-write pattern that allowed double
  // pipeline_leads inserts (smoke finding #13).
  const claimStamp = new Date().toISOString();
  const { data: claimed, error: claimErr } = await supabase
    .from("discovery_leads")
    .update({ promoted_at: claimStamp, email })
    .eq("id", id)
    .is("promoted_at", null)
    .select("id");

  if (claimErr) {
    if (isMissingTableError(claimErr.message, "discovery_leads")) {
      return NextResponse.json(
        {
          error:
            "discovery_leads table not found — apply migration 004 (POST /api/migrate/004-discovery)",
        },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: claimErr.message }, { status: 500 });
  }
  if (!claimed || claimed.length === 0) {
    // We lost the race — another concurrent request already promoted
    // this row. Look up its pipeline lead and return 409 (the same
    // shape as the fast-path branch above).
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

  // Best-effort score before insert so the row never lands as null.
  let localScore: number | null = null;
  try {
    localScore = await scoreWithGemini(title, disc.bio || "");
  } catch { /* non-blocking */ }

  // Resolve to a persons row so the dedup gate sees this lead and so a
  // future merge with arxiv-side or email-side identifiers points to one
  // canonical person. The previous implementation never set person_id on
  // the new pipeline_leads row, which silently bypassed the dedup gate.
  // Reference: SMOKE_TEST_REPORT_2026-05-09.md finding #12.
  //
  // discovery_leads.external_id is the source-native handle:
  //   source='hf'     → HF username
  //   source='github' → GitHub login
  //   source='ph'     → Product Hunt username (no person identifier)
  // We pass the relevant one and the email; resolvePerson handles
  // find-or-create + auto-merge.
  let personId: string | null = null;
  try {
    const resolved = await resolvePerson({
      email,
      hf_user: disc.source === "hf" ? disc.external_id : undefined,
      github_user: disc.source === "github" ? disc.external_id : undefined,
      arxiv_author_name: disc.fullname || undefined,
    });
    personId = resolved.id;
  } catch (err) {
    // Non-fatal: a missing persons table or a transient error shouldn't
    // block the promote. Log and continue with person_id=null (legacy
    // rows already exist this way).
    console.error("[discovery/promote] resolvePerson failed", err);
  }

  // NOTE: discovery_leads.signals (top_model, downloads, star_count,
  // twitter, languages, ...) is currently dropped on the floor here.
  // pipeline_leads has no signals jsonb column today, so we cannot copy
  // it without a schema change. Tracked under SMOKE_TEST_REPORT
  // finding #12 — re-introduce when pipeline_leads.signals lands.

  const { data: inserted, error: insertErr } = await supabase
    .from("pipeline_leads")
    .insert({
      arxiv_id: arxivId,
      title,
      abstract: disc.bio || "",
      author_name: authorName,
      author_email: email.trim().toLowerCase(),
      school_name: disc.org,
      status: "queued",
      source: sourceLabel,
      lead_tier: leadTier,
      assigned_rep_id: repId,
      local_score: localScore,
      person_id: personId,
    })
    .select("id")
    .single();

  if (insertErr) {
    // We claimed the discovery row but failed to insert pipeline_leads.
    // Roll the claim back so the next request can retry — otherwise
    // this discovery would be stuck "promoted" with no pipeline lead.
    await supabase
      .from("discovery_leads")
      .update({ promoted_at: null })
      .eq("id", id)
      .eq("promoted_at", claimStamp);

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

  return NextResponse.json({
    success: true,
    pipelineLeadId,
    repId,
    repName: rep?.name ?? null,
    leadTier,
  });
}
