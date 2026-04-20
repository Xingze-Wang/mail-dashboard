import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import type { DiscoveryLead } from "@/app/pipeline/types";
import { DISCOVERY_SOURCES, type SourceCode } from "@/lib/sources";

/**
 * GET /api/discovery
 *
 * Read endpoint for the multi-source scout pipeline. The Python scrapers
 * write to `discovery_leads`; this surfaces those rows for the dashboard.
 *
 * Query params:
 *   source           optional, comma-separated list (e.g. "hf,ph")
 *   minScore         optional, default 0
 *   hasEmail         optional, "yes" | "no" (unset = no filter)
 *   includePromoted  optional, "true" to include rows with promoted_at != null
 *                    (default: hide them — once promoted they live in
 *                    pipeline_leads and showing them in both lists would be
 *                    confusing)
 *   limit            default 100, max 500
 *   offset           default 0
 *
 * Response:
 *   {
 *     leads:    DiscoveryLead[],
 *     total:    number,                    // total rows matching filters
 *     bySource: { hf: number, ph: number, github: number }
 *   }
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;

  // ── parse filters ────────────────────────────────────────────────
  const sourceParam = sp.get("source");
  const requestedSources: SourceCode[] | null = sourceParam
    ? sourceParam
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s): s is SourceCode =>
          (DISCOVERY_SOURCES as ReadonlyArray<string>).includes(s),
        )
    : null;

  const minScoreRaw = sp.get("minScore");
  const minScore = minScoreRaw !== null ? Number(minScoreRaw) : 0;
  const hasEmail = sp.get("hasEmail"); // "yes" | "no" | null
  const includePromoted = sp.get("includePromoted") === "true";

  const limitRaw = sp.get("limit");
  const limit = Math.min(
    Math.max(1, limitRaw !== null ? Number(limitRaw) || 100 : 100),
    500,
  );
  const offsetRaw = sp.get("offset");
  const offset = Math.max(0, offsetRaw !== null ? Number(offsetRaw) || 0 : 0);

  // ── leads query ──────────────────────────────────────────────────
  let q = supabase
    .from("discovery_leads")
    .select(
      "id, source, external_id, score, signals, profile_url, fullname, location, org, bio, contact_hint, email, promoted_at, first_seen, last_seen, hit_count",
      { count: "exact" },
    )
    .gte("score", Number.isFinite(minScore) ? minScore : 0)
    .order("score", { ascending: false })
    .range(offset, offset + limit - 1);

  if (requestedSources && requestedSources.length > 0) {
    q = q.in("source", requestedSources);
  }
  if (hasEmail === "yes") q = q.not("email", "is", null);
  if (hasEmail === "no") q = q.is("email", null);
  // Promoted rows already live in pipeline_leads — exclude by default so
  // the discovery stream doesn't double-show them. Pass ?includePromoted=true
  // to inspect history.
  if (!includePromoted) q = q.is("promoted_at", null);

  const { data: rows, count, error } = await q;

  if (error) {
    return NextResponse.json(
      { error: error.message, leads: [], total: 0, bySource: { hf: 0, ph: 0, github: 0 } },
      { status: 500 },
    );
  }

  // ── per-source totals (unfiltered by score / email; filtered by source param) ──
  // We surface the full per-source funnel so the UI can show "1247 hf leads"
  // even when the active filters narrow the page. To avoid N round-trips we
  // run them in parallel.
  const bySourceEntries = await Promise.all(
    DISCOVERY_SOURCES.map(async (src) => {
      const { count: c } = await supabase
        .from("discovery_leads")
        .select("id", { count: "exact", head: true })
        .eq("source", src);
      return [src, c ?? 0] as const;
    }),
  );
  const bySource = Object.fromEntries(bySourceEntries) as Record<SourceCode, number>;

  const leads: DiscoveryLead[] = (rows ?? []).map((r) => ({
    id: r.id as number,
    source: r.source as string,
    externalId: r.external_id as string,
    score: r.score as number,
    signals: (r.signals ?? {}) as Record<string, unknown>,
    profileUrl: r.profile_url as string | null,
    fullname: r.fullname as string | null,
    location: r.location as string | null,
    org: r.org as string | null,
    bio: r.bio as string | null,
    contactHint: r.contact_hint as string | null,
    email: r.email as string | null,
    promotedAt: r.promoted_at as string | null,
    firstSeen: r.first_seen as string,
    lastSeen: r.last_seen as string,
    hitCount: r.hit_count as number,
  }));

  return NextResponse.json({
    leads,
    total: count ?? leads.length,
    bySource,
  });
}
