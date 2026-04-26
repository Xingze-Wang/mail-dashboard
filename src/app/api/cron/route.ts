import { NextRequest, NextResponse } from "next/server";
import { syncFromResend } from "@/lib/sync";
import { scanArxiv } from "@/lib/scanner";
import { generateDraft } from "@/lib/email-generator";
import { supabase } from "@/lib/db";
import { lookupAuthor } from "@/lib/semantic-scholar";
import { runDriftMine } from "@/app/api/drift/mine/route";
import { emitRetrainSignals, buildProposal } from "@/lib/retrain-signals";
import {
  getAssignmentConfig,
  classifyLead,
  assignRep,
  getRep,
} from "@/lib/assignment";

// Vercel Pro caps function execution at 300s; Hobby caps at 60s. Cron does
// sync + scan + draft in one pass and historically takes 3-5 min.
export const maxDuration = 300;

/**
 * Unified weekday cron endpoint.
 * Runs every weekday at 6 AM UTC:
 *   1. Sync sent/inbound emails from Resend
 *   2. Scan arxiv for new leads + generate drafts
 *
 * Future: add GitHub startup finder, Jike founder radar, etc.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  }
  // Bearer-token only. The old implementation also accepted a referer-
  // matches-host fallback as "internal traffic" — but the referer is
  // client-controlled, so anyone could forge it and trigger cron work
  // (sync from Resend + scan arxiv + generate drafts = expensive +
  // writes to the DB). Auth by shared secret, no fallbacks.
  const isVercelCron = req.headers.get("authorization") === `Bearer ${secret}`;
  if (!isVercelCron) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const results: Record<string, unknown> = {};

  // ── Step 1: Sync emails from Resend ──
  // 60s budget — at ~700ms per Resend page (paced to stay under 5 rps)
  // and ~14 pages for our current volume, we need ~15s on the happy
  // path with margin for the inbound phase. The previous 10s budget
  // truncated at ~6 pages and missed daily click/bounce updates on
  // older rows, which is what eventually showed up as totals lagging
  // reality. Cron's overall maxDuration is 300s so we have room.
  try {
    const syncResult = await syncFromResend(60_000);
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
      const citationCount = s2?.citationCount ?? null;
      const tier = classifyLead(config, {
        citationCount,
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
          repName: rep?.sender_name,
          repWechatId: rep?.wechat_id,
          assignedRepId: repId,
        });
      } catch (err) {
        console.error("cron draft generation failed", { arxivId: lead.arxivId, err: String(err) });
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

  // ── Step 3: Mine prompt drift from recent sales edits ──
  // Capped at 60 leads so the LLM call stays under cron's 300s budget
  // even when the previous two steps ran long. Failure is non-blocking.
  //
  // Lookback is 90 days, not 30: at the current team volume (a handful
  // of edited drafts per month) a 30-day window often falls below the
  // miner's ≥3-pair threshold and the page stays empty for weeks.
  // 90 days is a safer floor for finding patterns without losing
  // recency — the miner ranks by occurrence_count anyway, so old
  // one-offs naturally fall off.
  try {
    const driftResult = await runDriftMine(60, 90);
    results.drift = driftResult;
  } catch (err) {
    results.drift = { error: String(err) };
  }

  // ── Step 4: Emit retrain signals + build proposal ──
  // Daily check whether enough new signal has accumulated to justify
  // proposing a model retrain to admin. Cheap (a few SELECTs); doesn't
  // actually retrain. Admin sees the proposal at /api/retrain/proposal.
  try {
    const emitResult = await emitRetrainSignals();
    const proposal = await buildProposal();
    results.retrain = { signalsEmitted: emitResult.emitted, proposal: proposal ? { id: proposal.id, signal_count: proposal.signal_count } : null };
  } catch (err) {
    results.retrain = { error: String(err) };
  }

  // ── Future steps ──
  // Step 5: GitHub startup finder
  // Step 6: Jike founder radar

  return NextResponse.json(results);
}
