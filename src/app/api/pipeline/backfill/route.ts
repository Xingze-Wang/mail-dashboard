import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { lookupAuthor } from "@/lib/semantic-scholar";
import { getAssignmentConfig, classifyLead, assignRep } from "@/lib/assignment";
import { getSchoolInfo } from "@/lib/email-generator";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Parse matched_directions from DB (may be JSON array string or comma-separated). */
function parseDirections(raw: unknown): string[] {
  if (!raw || typeof raw !== "string") return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed);
      return Array.isArray(arr) ? arr.map(String) : [];
    } catch {
      // fall through to comma split
    }
  }
  return trimmed.split(",").map((s: string) => s.trim()).filter(Boolean);
}

export const maxDuration = 300; // 5 min for Vercel

export async function POST(req: NextRequest) {
  // Auth check (same pattern as scan route)
  const referer = req.headers.get("referer") || "";
  const host = req.headers.get("host") || "__none__";
  const isInternal = referer.includes(host);

  if (process.env.CRON_SECRET && !isInternal) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Fetch all leads missing h_index OR with h_index=0 (possibly stale)
  // Also re-process leads that had no S2 match before (s2_author_id is null)
  const { data: leads, error } = await supabase
    .from("pipeline_leads")
    .select("*")
    .is("s2_author_id", null);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!leads || leads.length === 0) {
    return NextResponse.json({ total: 0, enriched: 0, failed: 0, skipped: 0 });
  }

  const config = await getAssignmentConfig();
  let enriched = 0;
  let failed = 0;
  let skipped = 0;
  const details: Array<{
    id: number;
    author_name: string;
    h_index: number | null;
    lead_tier: string | null;
    assigned_rep_id: number | null;
    status: string;
  }> = [];

  for (const lead of leads) {
    // Need title + author_name for S2 lookup
    if (!lead.title || !lead.author_name) {
      skipped++;
      details.push({
        id: lead.id,
        author_name: lead.author_name || "(missing)",
        h_index: null,
        lead_tier: null,
        assigned_rep_id: null,
        status: "skipped_missing_data",
      });
      continue;
    }

    try {
      // S2 enrichment
      const s2 = await lookupAuthor(lead.title, lead.author_name);

      const s2AuthorId = s2?.authorId ?? null;
      const hIndex = s2?.hIndex ?? null;
      const citationCount = s2?.citationCount ?? null;
      const paperCount = s2?.paperCount ?? null;

      // School info (only if currently null)
      let schoolName = lead.school_name;
      let schoolTier = lead.school_tier;
      if ((!schoolName || !schoolTier) && lead.author_email) {
        const info = getSchoolInfo(lead.author_email);
        if (info) {
          if (!schoolName) schoolName = info.name;
          if (schoolTier === null || schoolTier === undefined) schoolTier = info.tier;
        }
      }

      // Classification + assignment
      let leadTier: "strong" | "normal" = "normal";
      let assignedRepId: number | null = null;
      try {
        leadTier = classifyLead(config, {
          hIndex,
          schoolTier,
          authorEmail: lead.author_email || "",
        });
        const dirs = parseDirections(lead.matched_directions);
        assignedRepId = assignRep(config, leadTier, lead.author_email || undefined, dirs);
      } catch {
        // Classification failure is non-blocking
      }

      // Update the lead
      await supabase
        .from("pipeline_leads")
        .update({
          s2_author_id: s2AuthorId,
          h_index: hIndex,
          citation_count: citationCount,
          paper_count: paperCount,
          school_name: schoolName,
          school_tier: schoolTier,
          lead_tier: leadTier,
          assigned_rep_id: assignedRepId,
        })
        .eq("id", lead.id);

      enriched++;
      details.push({
        id: lead.id,
        author_name: lead.author_name,
        h_index: hIndex,
        lead_tier: leadTier,
        assigned_rep_id: assignedRepId,
        status: s2 ? "enriched" : "enriched_no_s2_match",
      });
    } catch (err) {
      failed++;
      details.push({
        id: lead.id,
        author_name: lead.author_name,
        h_index: null,
        lead_tier: null,
        assigned_rep_id: null,
        status: `error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Rate limit delay — S2 allows ~1 req/sec, and our lookupAuthor
    // can make 2-3 calls internally, so we need generous spacing
    await sleep(3000);
  }

  return NextResponse.json({
    total: leads.length,
    enriched,
    failed,
    skipped,
    details,
  });
}
