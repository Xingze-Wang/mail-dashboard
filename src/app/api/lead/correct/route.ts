import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";
import { blockEmail } from "@/lib/blocklist";

export const dynamic = "force-dynamic";

/**
 * POST /api/lead/correct
 * Body: {
 *   leadId: string
 *   type: CorrectionType
 *   reason?: string                  // short free-text
 *   payload?: object                 // type-specific extras
 *   skip?: boolean                   // also flip lead.status='skipped'
 * }
 *
 * GET  /api/lead/correct?leadId=xxx  → list corrections for one lead
 *
 * Sales-facing endpoint: any logged-in rep can flag any lead. We don't
 * gate on assigned_rep_id because the reviewer might be admin or another
 * rep helping out.
 *
 * Single Source of Truth note: this table holds *signals*, not labels.
 * The training pipeline merges signals (sales flags + WeChat conversion +
 * inbound replies + bounces) via weighted vote to produce the final
 * label. Sales saying "bad_compute" doesn't override the data.
 */

const VALID_TYPES = new Set([
  "bad_compute",
  "wrong_author",
  "wrong_direction",
  "low_quality_email",
  "right_lead_wrong_pitch",
  "good_lead",
]);

export async function POST(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const leadId = String(body.leadId ?? "").trim();
  const type = String(body.type ?? "").trim();
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : null;
  const payload = body.payload && typeof body.payload === "object" ? body.payload : null;
  const skip = body.skip === true;
  // 'soft' = note for monitoring; 'hard' = block this person from ever
  // being sent to. Hard requires senior or admin role — junior sales can
  // still flag soft, just can't escalate to blocklist.
  const severityRaw = String(body.severity ?? "soft").toLowerCase();
  const severity: "soft" | "hard" = severityRaw === "hard" ? "hard" : "soft";
  if (severity === "hard" && session.role !== "admin" && session.role !== "senior") {
    return NextResponse.json(
      { error: "Hard-flagging (blocking a recipient) requires senior or admin role." },
      { status: 403 },
    );
  }

  if (!leadId) return NextResponse.json({ error: "leadId required" }, { status: 400 });
  if (!VALID_TYPES.has(type)) {
    return NextResponse.json(
      { error: `Invalid type. Must be one of: ${Array.from(VALID_TYPES).join(", ")}` },
      { status: 400 },
    );
  }

  const { data: lead } = await supabase
    .from("pipeline_leads")
    .select("id, author_email")
    .eq("id", leadId)
    .maybeSingle();
  if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });

  const { data: row, error } = await supabase
    .from("lead_corrections")
    .insert({
      lead_id: leadId,
      rep_id: session.repId,      // canonical FK — used by drift Human Signals + per-rep analytics
      type,
      reason,
      payload,
      severity,
      corrected_by: session.email, // legacy field kept for back-compat with pre-rep_id inserts
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let blockedEmail: string | null = null;
  if (severity === "hard") {
    // Hard flag = block this person from ever being sent to + skip the
    // current lead. The block reason carries the correction type so admin
    // can audit later.
    const em = (lead.author_email as string | null)?.toLowerCase().trim() ?? "";
    if (em) {
      const ok = await blockEmail(em, `${type}: ${reason ?? "(no reason)"}`, session.email);
      if (ok) blockedEmail = em;
    }
    await supabase
      .from("pipeline_leads")
      .update({ status: "skipped" })
      .eq("id", leadId);
  } else if (skip && (type === "bad_compute" || type === "wrong_author" || type === "wrong_direction")) {
    await supabase
      .from("pipeline_leads")
      .update({ status: "skipped" })
      .eq("id", leadId);
  }

  return NextResponse.json({ ok: true, correction: row, blockedEmail });
}

export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const leadId = url.searchParams.get("leadId");
  if (!leadId) return NextResponse.json({ error: "leadId required" }, { status: 400 });

  const { data, error } = await supabase
    .from("lead_corrections")
    .select("*")
    .eq("lead_id", leadId)
    .order("corrected_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ corrections: data ?? [] });
}
