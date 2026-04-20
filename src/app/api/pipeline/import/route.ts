import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { wasRecentlyContacted } from "@/lib/contact-guard";
import { lookupAuthor } from "@/lib/semantic-scholar";
import { lookupCitationsViaTavily } from "@/lib/tavily";
import { generateDraft } from "@/lib/email-generator";
import { getRep } from "@/lib/assignment";
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
    const errors: string[] = [];
    const blockedByGuard: { email: string; lastContactedAt: string }[] = [];

    // Load assignment config once for the whole batch
    const config = await getAssignmentConfig();

    for (const lead of leads) {
      const email = lead.authorEmail as string;
      if (!email) {
        errors.push("Missing authorEmail");
        skipped++;
        continue;
      }

      // Backstop the Python-side dedup: refuse to import a lead for any
      // recipient we've already emailed in the last 365 days, regardless
      // of what Python's local JSON thinks.
      const contact = await wasRecentlyContacted(email);
      if (contact.contacted) {
        blockedByGuard.push({ email, lastContactedAt: contact.lastAt! });
        skipped++;
        continue;
      }

      const title = (lead.title as string) || "(untitled)";
      const source = (lead.source as string) || "external";
      const authorName = (lead.authorName as string) || null;
      const schoolTier = (lead.schoolTier as number) || null;

      // Semantic Scholar enrichment (best-effort). Falls back to email local-part
      // (e.g. "first.last@univ.edu") when authorName is missing — this catches
      // the common case where Python imports only have an email address.
      let lookupName = authorName;
      if (!lookupName && email.includes("@")) {
        const local = email.split("@")[0];
        const guessed = local.replace(/[._\-]+/g, " ").trim();
        if (guessed.length >= 3 && /^[a-zA-Z ]+$/.test(guessed)) lookupName = guessed;
      }
      let s2: Awaited<ReturnType<typeof lookupAuthor>> = null;
      if (lookupName) {
        try {
          s2 = await lookupAuthor(title, lookupName);
        } catch (err) {
          console.error("S2 lookup failed", { email, lookupName, err: String(err) });
        }
      }

      let citationCount = s2?.citationCount ?? null;
      const hIndex = s2?.hIndex ?? null;

      // Tavily fallback — hits Google Scholar via web search when S2 has no
      // profile for this author (common for fresh PhDs / industry names /
      // highly-collided Chinese names). Best-effort; logs failures.
      if (citationCount === null && lookupName) {
        try {
          const tav = await lookupCitationsViaTavily(lookupName, email);
          if (tav?.citationCount) {
            citationCount = tav.citationCount;
            console.log("Tavily citation hit", { email, name: lookupName, count: tav.citationCount });
          }
        } catch (err) {
          console.error("Tavily lookup threw", { email, err: String(err) });
        }
      }

      const leadTier = classifyLead(config, {
        citationCount,
        hIndex,
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

      // Draft is generated server-side with the assigned rep's identity.
      // Python scrapers no longer send draft_subject/draft_html — if they do,
      // we still regenerate to guarantee the signature matches the assignee.
      const rep = await getRep(assignedRepId);
      const matchedDirsArr = typeof lead.matchedDirections === "string"
        ? (lead.matchedDirections as string).split(",").map((s) => s.trim()).filter(Boolean)
        : Array.isArray(lead.matchedDirections) ? (lead.matchedDirections as string[]) : [];
      let draft: { subject: string; html: string } | null = null;
      try {
        draft = await generateDraft({
          title,
          abstract: (lead.abstract as string) || "",
          authorEmail: email,
          firstName: (lead.firstName as string) || null,
          schoolName: (lead.schoolName as string) || null,
          schoolTier,
          matchedDirections: matchedDirsArr,
          repName: rep?.sender_name,
          repWechatId: rep?.wechat_id,
        });
      } catch (err) {
        console.error("generateDraft failed", { email, err: String(err) });
      }

      const hasDraft = !!draft || !!(lead.draftSubject && lead.draftHtml);

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
        draft_subject: draft?.subject ?? (lead.draftSubject as string) ?? null,
        draft_html: draft?.html ?? (lead.draftHtml as string) ?? null,
        status: hasDraft ? "ready" : "new",
        source,
        s2_author_id: s2?.authorId ?? null,
        h_index: hIndex,
        citation_count: citationCount,
        paper_count: s2?.paperCount ?? null,
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

    return NextResponse.json({ imported, skipped, errors, blockedByGuard });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Import failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
