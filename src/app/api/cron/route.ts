import { NextRequest, NextResponse } from "next/server";
import { syncFromResend } from "@/lib/sync";
import { scanArxiv } from "@/lib/scanner";
import { generateDraft } from "@/lib/email-generator";
import { supabase } from "@/lib/db";

/**
 * Unified weekday cron endpoint.
 * Runs every weekday at 6 AM UTC:
 *   1. Sync sent/inbound emails from Resend
 *   2. Scan arxiv for new leads + generate drafts
 *
 * Future: add GitHub startup finder, Jike founder radar, etc.
 */
export async function GET(req: NextRequest) {
  const isVercelCron = req.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
  const referer = req.headers.get("referer") || "";
  const host = req.headers.get("host") || "__none__";
  const isInternal = referer.includes(host);

  if (process.env.CRON_SECRET && !isVercelCron && !isInternal) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const results: Record<string, unknown> = {};

  // ── Step 1: Sync emails from Resend ──
  try {
    const syncResult = await syncFromResend(10_000);
    results.sync = syncResult;
  } catch (err) {
    results.sync = { error: String(err) };
  }

  // ── Step 2: Scan arxiv for new leads ──
  try {
    const { leads, stats } = await scanArxiv({ maxPapers: 300, timeBudgetMs: 40_000 });
    let leadsCreated = 0;

    for (const lead of leads) {
      let draft: { subject: string; html: string } | null = null;
      try {
        draft = await generateDraft({
          title: lead.title,
          abstract: lead.abstract,
          authorEmail: lead.authorEmail,
          firstName: lead.firstName,
          schoolName: lead.schoolName,
          schoolTier: lead.schoolTier,
          matchedDirections: lead.matchedDirections,
        });
      } catch {
        // Draft failed — insert with status 'new'
      }

      const { error } = await supabase.from("pipeline_leads").insert({
        arxiv_id: lead.arxivId,
        title: lead.title,
        abstract: lead.abstract,
        authors: lead.authors,
        pdf_url: lead.pdfUrl,
        published_at: lead.publishedAt,
        author_name: lead.authorName,
        author_email: lead.authorEmail,
        first_name: lead.firstName,
        school_name: lead.schoolName,
        school_tier: lead.schoolTier,
        compute_level: lead.computeLevel,
        compute_confidence: lead.computeConfidence,
        compute_reason: lead.computeReason,
        matched_directions: Array.isArray(lead.matchedDirections) ? lead.matchedDirections.join(",") : "",
        draft_subject: draft?.subject ?? null,
        draft_html: draft?.html ?? null,
        status: draft ? "ready" : "new",
      });

      if (!error) leadsCreated++;
    }

    results.pipeline = { stats, leadsCreated };
  } catch (err) {
    results.pipeline = { error: String(err) };
  }

  // ── Future steps ──
  // Step 3: GitHub startup finder
  // Step 4: Jike founder radar

  return NextResponse.json(results);
}
