import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";

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
    const errors: string[] = [];

    for (const lead of leads) {
      const email = lead.authorEmail as string;
      if (!email) {
        errors.push("Missing authorEmail");
        skipped++;
        continue;
      }

      const title = (lead.title as string) || "(untitled)";
      const source = (lead.source as string) || "external";

      // Generate a unique ID if no arxivId provided
      const arxivId = (lead.arxivId as string) ||
        `${source}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

      const hasDraft = !!(lead.draftSubject && lead.draftHtml);

      const { error } = await supabase.from("pipeline_leads").insert({
        arxiv_id: arxivId,
        title,
        abstract: (lead.abstract as string) || null,
        authors: (lead.authorName as string) || null,
        pdf_url: (lead.pdfUrl as string) || null,
        published_at: (lead.publishedAt as string) || null,
        author_name: (lead.authorName as string) || null,
        author_email: email,
        first_name: (lead.firstName as string) || null,
        school_name: (lead.schoolName as string) || null,
        school_tier: (lead.schoolTier as number) || null,
        compute_level: (lead.computeLevel as string) || null,
        compute_confidence: (lead.computeConfidence as number) || null,
        compute_reason: (lead.computeReason as string) || null,
        matched_directions: (lead.matchedDirections as string) || null,
        draft_subject: (lead.draftSubject as string) || null,
        draft_html: (lead.draftHtml as string) || null,
        status: hasDraft ? "ready" : "new",
        source,
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

    return NextResponse.json({ imported, skipped, errors });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Import failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
