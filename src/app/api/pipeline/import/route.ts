import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { wasRecentlyContacted } from "@/lib/contact-guard";
import {
  getAssignmentConfig,
  classifyLead,
  assignRep,
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
      // Lowercase early so dedup and contact-guard see a canonical form.
      const email = rawEmail.trim().toLowerCase();

      // Backstop the Python-side dedup: refuse to import a lead for any
      // recipient we've already emailed in the last 365 days, regardless
      // of what Python's local JSON thinks.
      const contact = await wasRecentlyContacted(email);
      if (contact.contacted) {
        blockedByGuard.push({ email, lastContactedAt: contact.lastAt! });
        skipped++;
        continue;
      }

      // Dedup against rows already in pipeline_leads:
      //   (a) same email — different paper but same person
      //   (b) same arxiv_id — same paper, different co-author
      // Either case: we already have outreach in flight, don't double up.
      const incomingArxivId = (lead.arxivId as string) || null;
      const orFilter = incomingArxivId
        ? `author_email.ilike.${email},arxiv_id.eq.${incomingArxivId}`
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

      // Enrichment (S2 + Tavily) is deferred to the draft-queue worker so the
      // import request stays < 2s even for 50-lead batches. Classification
      // runs here with what the caller gave us — typically school_tier. Leads
      // that should be "strong" solely on citation will be reclassified when
      // the worker runs, because it updates lead_tier after enrichment.
      const leadTier = classifyLead(config, {
        citationCount: null,
        hIndex: null,
        schoolTier,
        authorEmail: email,
      });
      const assignedRepId = assignRep(
        config,
        leadTier,
        email,
        (lead.matchedDirections as string) ?? null,
      );

      // Generate a unique ID if no arxivId provided
      const arxivId = (lead.arxivId as string) ||
        `${source}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

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
        draft_subject: null,
        draft_html: null,
        status: "queued",
        local_score: typeof lead.localScore === "number" ? lead.localScore : null,
        source,
        s2_author_id: null,
        h_index: null,
        citation_count: null,
        paper_count: null,
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
