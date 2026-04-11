import { NextRequest, NextResponse } from "next/server";
import { syncFromResend } from "@/lib/sync";
import { scanArxiv } from "@/lib/scanner";
import { generateDraft } from "@/lib/email-generator";
import { supabase } from "@/lib/db";
import { lookupAuthor } from "@/lib/semantic-scholar";
import {
  getAssignmentConfig,
  classifyLead,
  assignRep,
  getRep,
} from "@/lib/assignment";

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

  // ── Step 2: Scan arxiv for new leads → enrich → classify → assign → draft ──
  try {
    const { leads, stats } = await scanArxiv({ maxPapers: 300, timeBudgetMs: 40_000 });
    const config = await getAssignmentConfig();
    let leadsCreated = 0;

    for (const lead of leads) {
      // 1. Semantic Scholar enrichment (best-effort)
      let s2: Awaited<ReturnType<typeof lookupAuthor>> = null;
      try {
        s2 = await lookupAuthor(lead.title, lead.authorName);
      } catch {
        // S2 enrichment failure is non-blocking
      }

      // 2. Classify and assign
      const hIndex = s2?.hIndex ?? null;
      const tier = classifyLead(config, {
        hIndex,
        schoolTier: lead.schoolTier,
        authorEmail: lead.authorEmail,
      });
      const repId = assignRep(config, tier, lead.authorEmail);

      // 3. Get rep info for draft generation
      const rep = await getRep(repId);

      // 4. Generate draft with rep identity
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
          repName: rep?.name,
          repWechatId: rep?.wechat_id,
        });
      } catch {
        // Draft failed — insert with status 'new'
      }

      // 5. Insert with enrichment data
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
        matched_directions: lead.matchedDirections,
        draft_subject: draft?.subject ?? null,
        draft_html: draft?.html ?? null,
        status: draft ? "ready" : "new",
        s2_author_id: s2?.authorId ?? null,
        h_index: s2?.hIndex ?? null,
        citation_count: s2?.citationCount ?? null,
        paper_count: s2?.paperCount ?? null,
        lead_tier: tier,
        assigned_rep_id: repId,
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
