import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";
import { getConfig, setConfig } from "@/lib/system-config";
import { classifyLead, assignRep, defaultConfig, type AssignmentConfig } from "@/lib/assignment";

export const dynamic = "force-dynamic";

/**
 * GET  /api/scorer/assignment-config
 *   Returns current config + default config.
 * PUT  /api/scorer/assignment-config
 *   Body: { config: AssignmentConfig }  — validates and persists.
 * POST /api/scorer/assignment-config/preview
 *   (handled below via body.preview === true on PUT to avoid another route)
 *   Body: { config, preview: true } — runs proposed config against historical
 *   leads and reports how many would be re-routed vs today.
 */

function validate(c: unknown): c is AssignmentConfig {
  if (!c || typeof c !== "object") return false;
  const cfg = c as Record<string, unknown>;
  const sc = cfg.strong_criteria as Record<string, unknown> | undefined;
  const as = cfg.assignment as Record<string, unknown> | undefined;
  if (!sc || !as) return false;
  if (typeof sc.min_citation !== "number") return false;
  if (typeof sc.min_citation_unverified !== "number") return false;
  if (typeof sc.max_school_tier !== "number") return false;
  if (typeof sc.min_local_score !== "number") return false;
  const strong = as.strong as Record<string, unknown> | undefined;
  const overseas = as.overseas as Record<string, unknown> | undefined;
  const domestic = as.domestic as Record<string, unknown> | undefined;
  if (!strong || typeof strong.rep_id !== "number") return false;
  if (!overseas || typeof overseas.rep_id !== "number") return false;
  if (!domestic || typeof domestic.rep_id !== "number") return false;
  if (as.by_direction !== undefined) {
    if (typeof as.by_direction !== "object" || as.by_direction === null) return false;
  }
  return true;
}

export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;
  const current = (await getConfig<AssignmentConfig>("lead_assignment")) ?? defaultConfig();
  return NextResponse.json({ current, default: defaultConfig() });
}

export async function PUT(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const body = await req.json().catch(() => ({}));
  if (!validate(body.config)) {
    return NextResponse.json({ error: "Invalid config shape" }, { status: 400 });
  }
  const proposed = body.config as AssignmentConfig;

  // ── Preview mode: don't persist, just report what would change.
  if (body.preview === true) {
    const { data: leadsRaw } = await supabase
      .from("pipeline_leads")
      .select("id, author_email, citation_count, h_index, school_tier, local_score, assigned_rep_id, matched_directions, lead_tier, status");
    const leads = leadsRaw ?? [];

    let reroutes = 0;
    let tierFlips = 0;
    const byOldRep = new Map<number | null, number>();
    const byNewRep = new Map<number | null, number>();
    for (const l of leads) {
      const matched = parseMatched(l.matched_directions);
      const newTier = classifyLead(proposed, {
        citationCount: l.citation_count,
        hIndex: l.h_index,
        schoolTier: l.school_tier,
        authorEmail: l.author_email ?? undefined,
        localScore: l.local_score,
      });
      const newRep = assignRep(proposed, newTier, l.author_email ?? undefined, matched);
      if (newTier !== (l.lead_tier ?? "normal")) tierFlips++;
      if (l.assigned_rep_id !== null && l.assigned_rep_id !== newRep) reroutes++;
      byOldRep.set(l.assigned_rep_id, (byOldRep.get(l.assigned_rep_id) ?? 0) + 1);
      byNewRep.set(newRep, (byNewRep.get(newRep) ?? 0) + 1);
    }
    return NextResponse.json({
      preview: true,
      nLeads: leads.length,
      reroutes,
      tierFlips,
      byOldRep: Object.fromEntries(byOldRep),
      byNewRep: Object.fromEntries(byNewRep),
    });
  }

  const ok = await setConfig("lead_assignment", {
    ...proposed,
    updated_at: new Date().toISOString(),
    updated_by: gate.session.email,
  });
  if (!ok) return NextResponse.json({ error: "Failed to persist" }, { status: 500 });
  return NextResponse.json({ ok: true });
}

function parseMatched(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const p = JSON.parse(raw);
    if (Array.isArray(p)) return p.map(String);
  } catch {
    // not JSON
  }
  return String(raw).split(",").map((s) => s.trim()).filter(Boolean);
}
