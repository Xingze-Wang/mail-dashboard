import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { wasRecentlyContacted, paperWasRecentlyContacted } from "@/lib/contact-guard";
import { canonicalizeEmail } from "@/lib/email-id";
import { canonicalizeArxivId } from "@/lib/arxiv-id";
import { fillRepPlaceholders } from "@/lib/rep-template";
import { scoreWithGemini } from "@/lib/gemini-scorer";
import { lookupAuthor } from "@/lib/semantic-scholar";
import {
  getAssignmentConfig,
  classifyLead,
  assignRep,
  getRep,
} from "@/lib/assignment";

/**
 * POST /api/pipeline/import
 *
 * Universal lead import endpoint. Accepts leads from any source
 * (Python scripts, manual entry, external tools).
 *
 * Body: single lead or array of leads
 * {
 *   "leads": [{
 *     "title": "Company Name or Paper Title",
 *     "authorEmail": "founder@startup.com",        // required
 *     "authorName": "John Doe",
 *     "source": "github",                          // github, jike, manual, etc.
 *     "draftSubject": "Subject line",
 *     "draftHtml": "<p>Email body</p>",
 *     "abstract": "Description or context",
 *     "schoolName": "MIT",
 *     "computeLevel": "heavy",
 *     "computeConfidence": 0.8,
 *     "computeReason": "Why this lead matters",
 *     "matchedDirections": "ai,robotics",
 *     "arxivId": "2604.12345",                     // optional, for arxiv leads
 *     "pdfUrl": "https://...",
 *     "publishedAt": "2026-04-05T00:00:00Z",
 *   }]
 * }
 *
 * Or shorthand for single lead (no "leads" wrapper):
 * { "title": "...", "authorEmail": "...", ... }
 *
 * Auth: API key via Authorization header, or internal referer.
 * Set PIPELINE_IMPORT_KEY env var to require auth.
 */
export async function POST(req: NextRequest) {
  // Auth check
  const importKey = process.env.PIPELINE_IMPORT_KEY;
  if (importKey) {
    const auth = req.headers.get("authorization");
    const referer = req.headers.get("referer") || "";
    const host = req.headers.get("host") || "__none__";
    const isInternal = referer.includes(host);

    if (!isInternal && auth !== `Bearer ${importKey}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const body = await req.json();

    // Accept single lead or array
    const leads: Record<string, unknown>[] = body.leads
      ? body.leads
      : [body];

    let imported = 0;
    let skipped = 0;
    let duplicateInPipeline = 0;
    const errors: string[] = [];
    const blockedByGuard: { email: string; lastContactedAt: string }[] = [];

    // Load assignment config once for the whole batch
    const config = await getAssignmentConfig();

    for (const lead of leads) {
      const rawEmail = lead.authorEmail as string;
      if (!rawEmail) {
        errors.push("Missing authorEmail");
        skipped++;
        continue;
      }
      // Aggressively canonicalize so dedup catches:
      //   - mixed case
      //   - "+tag" subaddresses (john+work@x.com → john@x.com)
      //   - Gmail dots and googlemail.com aliases
      const email = canonicalizeEmail(rawEmail);

      // Person firewall — has anyone contacted THIS RECIPIENT in 365 days?
      // Three tables (emails / email_contact_history / persons) — see
      // src/lib/contact-guard.ts.
      const contact = await wasRecentlyContacted(email);
      if (contact.contacted) {
        blockedByGuard.push({ email, lastContactedAt: contact.lastAt! });
        skipped++;
        continue;
      }

      // Paper firewall — has ANY co-author of this paper been contacted in
      // 365 days? Prevents the "different author, same paper" loophole that
      // pipeline_leads dedup misses if the row was deleted/skipped.
      // Try arxivId first; if absent, derive from pdfUrl. Both go through
      // canonicalize so format variants collapse to the same string.
      const incomingArxivIdRaw =
        (lead.arxivId as string) || (lead.pdfUrl as string) || null;
      const arxivIdCanonical = canonicalizeArxivId(incomingArxivIdRaw);
      if (arxivIdCanonical && arxivIdCanonical.match(/^\d{4}\.\d{4,5}/)) {
        const paperHit = await paperWasRecentlyContacted(arxivIdCanonical);
        if (paperHit.contacted) {
          blockedByGuard.push({
            email: `[paper ${arxivIdCanonical}] ${email}`,
            lastContactedAt: paperHit.lastAt!,
          });
          skipped++;
          continue;
        }
      }

      // Dedup against rows already in pipeline_leads:
      //   (a) same email — different paper but same person
      //   (b) same arxiv_id — same paper, different co-author
      const orFilter = arxivIdCanonical
        ? `author_email.ilike.${email},arxiv_id.eq.${arxivIdCanonical}`
        : `author_email.ilike.${email}`;
      const { data: existing } = await supabase
        .from("pipeline_leads")
        .select("id, status, author_email, arxiv_id")
        .or(orFilter)
        .not("status", "in", "(skipped,bounced)")
        .limit(1);
      if (existing && existing.length > 0) {
        duplicateInPipeline++;
        skipped++;
        continue;
      }

      const title = (lead.title as string) || "(untitled)";
      const source = (lead.source as string) || "external";
      const authorName = (lead.authorName as string) || null;
      const schoolTier = (lead.schoolTier as number) || null;

      // Classification uses what Python sent us. If Python missed citation
      // data (most leads — Python's S2 path is flaky), fall back to a quick
      // server-side S2 lookup. Adds ~3-5s to imports that need it but means
      // the dashboard actually has citation/h-index data to score on.
      let pyCitation = typeof lead.citationCount === "number" ? lead.citationCount : null;
      let pyHIndex = typeof lead.hIndex === "number" ? lead.hIndex : null;
      let pyS2AuthorId = (lead.s2AuthorId as string | null) ?? null;
      let pyPaperCount = typeof lead.paperCount === "number" ? lead.paperCount : null;
      const pyLocalScore = typeof lead.localScore === "number" ? lead.localScore : null;
      if (pyCitation === null && authorName) {
        try {
          const s2 = await lookupAuthor(title, authorName);
          if (s2) {
            pyCitation = s2.citationCount;
            pyHIndex = s2.hIndex;
            pyS2AuthorId = s2.authorId;
            pyPaperCount = s2.paperCount;
          }
        } catch {
          // S2 timeout / rate limit — leave nulls, backfill route can
          // pick this up later.
        }
      }
      const leadTier = classifyLead(config, {
        citationCount: pyCitation,
        hIndex: pyHIndex,
        schoolTier,
        authorEmail: email,
        localScore: pyLocalScore,
      });
      const assignedRepId = assignRep(
        config,
        leadTier,
        email,
        (lead.matchedDirections as string) ?? null,
      );

      // Prefer the canonicalized arxiv id; synthesize a unique one otherwise.
      const arxivId = arxivIdCanonical ||
        `${source}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

      // If Python supplied a draft (body + subject, typically with
      // {{REP_NAME}} / {{REP_WECHAT}} placeholders), fill those with the
      // assigned rep's identity and mark the lead 'ready' immediately.
      // Otherwise the draft-queue worker will generate from scratch later.
      // Scoring runs in parallel with the rep lookup so import stays fast.
      const incomingSubject = (lead.draftSubject as string) || null;
      const incomingHtml = (lead.draftHtml as string) || null;
      const incomingScore = typeof lead.localScore === "number" ? lead.localScore : null;
      const abstractStr = (lead.abstract as string) || "";

      const [repLookup, scoreLookup] = await Promise.all([
        incomingSubject && incomingHtml ? getRep(assignedRepId) : Promise.resolve(null),
        // Score every lead at import time, even when Python supplied a local_score
        // we trust that one; otherwise fire Gemini fallback. ~1-2s per call,
        // bounded by scoreWithGemini's 8s timeout, returns null on any failure.
        incomingScore !== null ? Promise.resolve(incomingScore) : scoreWithGemini(title, abstractStr),
      ]);

      let finalSubject: string | null = null;
      let finalHtml: string | null = null;
      let finalStatus: "ready" | "queued" = "queued";
      if (incomingSubject && incomingHtml) {
        const filled = fillRepPlaceholders(
          { subject: incomingSubject, html: incomingHtml },
          repLookup ? { sender_name: repLookup.sender_name, wechat_id: repLookup.wechat_id } : null,
        );
        finalSubject = filled.subject;
        finalHtml = filled.html;
        finalStatus = "ready";
      }
      const finalScore = scoreLookup ?? null;

      // Draft is generated server-side by /api/pipeline/draft-queue using the
      // assigned rep's identity — we do NOT trust incoming drafts from the
      // Python scraper (which signs everything as Leo). Any draft supplied
      // is discarded in favor of the queue-generated one.

      const { error } = await supabase.from("pipeline_leads").insert({
        arxiv_id: arxivId,
        title,
        abstract: (lead.abstract as string) || null,
        authors: authorName,
        pdf_url: (lead.pdfUrl as string) || null,
        published_at: (lead.publishedAt as string) || null,
        author_name: authorName,
        author_email: email,
        first_name: (lead.firstName as string) || null,
        school_name: (lead.schoolName as string) || null,
        school_tier: schoolTier,
        compute_level: (lead.computeLevel as string) || null,
        compute_confidence: (lead.computeConfidence as number) || null,
        compute_reason: (lead.computeReason as string) || null,
        matched_directions: (lead.matchedDirections as string) || null,
        draft_subject: finalSubject,
        draft_html: finalHtml,
        // Snapshot of the AI's original output so sales-edit diffs can be
        // mined. Identical to draft_* at insert time, but draft_* will be
        // overwritten by sales editing while these stay frozen.
        draft_original_subject: finalSubject,
        draft_original_html: finalHtml,
        draft_model: (lead.draftModel as string) || "python",
        status: finalStatus,
        local_score: finalScore,
        source,
        s2_author_id: pyS2AuthorId,
        h_index: pyHIndex,
        citation_count: pyCitation,
        paper_count: pyPaperCount,
        lead_tier: leadTier,
        assigned_rep_id: assignedRepId,
      });

      if (error) {
        if (error.message.includes("duplicate")) {
          skipped++;
        } else {
          errors.push(`${email}: ${error.message}`);
          skipped++;
        }
      } else {
        imported++;
      }
    }

    return NextResponse.json({ imported, skipped, duplicateInPipeline, errors, blockedByGuard });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Import failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
