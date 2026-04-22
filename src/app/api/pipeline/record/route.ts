import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { lookupAuthor } from "@/lib/semantic-scholar";
import { getAssignmentConfig, classifyLead, assignRep } from "@/lib/assignment";
import { getSchoolInfo } from "@/lib/email-generator";

/**
 * POST /api/pipeline/record
 *
 * Called by the Python script after sending an email.
 * Records the full paper + author context so the dashboard can link
 * emails back to papers and all co-authors.
 *
 * Body:
 * {
 *   paper: { arxiv_id, title, abstract, authors: string[], pdf_url, published },
 *   emailed: { email, author_name, first_name },
 *   all_authors: [{ email, author, first_name, is_chinese }],  // from email_matches
 *   compute: { level, confidence, reason },
 *   matched_directions: string[],
 *   subject: string,
 *   body_html: string
 * }
 */
export async function POST(req: NextRequest) {
  try {
    // Machine-to-machine endpoint — must be gated by CRON_SECRET.
    // Previously unauthenticated, so anyone could POST and insert
    // attacker-chosen leads / emails / arxiv rows into the DB.
    const auth = req.headers.get("authorization") || "";
    const expected = process.env.CRON_SECRET;
    if (!expected || auth !== `Bearer ${expected}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { paper, emailed, all_authors, compute, matched_directions, subject, body_html } = body;

    if (!paper?.arxiv_id || !emailed?.email) {
      return NextResponse.json({ error: "paper.arxiv_id and emailed.email required" }, { status: 400 });
    }

    // 1. Archive paper
    await supabase.from("papers").upsert({
      arxiv_id: paper.arxiv_id,
      title: paper.title,
      abstract: paper.abstract,
      authors: Array.isArray(paper.authors) ? paper.authors.join(", ") : paper.authors,
      pdf_url: paper.pdf_url,
      published_at: paper.published || null,
      compute_level: compute?.level || null,
      compute_confidence: compute?.confidence || null,
      compute_reason: compute?.reason || null,
      matched_directions: JSON.stringify(matched_directions || []),
    });

    // 2. Archive all authors (from email_matches + paper author list)
    const authorRows = (all_authors || []).map((a: Record<string, unknown>, i: number) => ({
      arxiv_id: paper.arxiv_id,
      author_name: a.author || null,
      first_name: a.first_name || null,
      email: a.email || null,
      is_chinese: a.is_chinese || false,
      position: i,
    }));

    // Also include paper authors not in email_matches
    const matchedNames = new Set(
      authorRows.filter((r: { author_name: string | null }) => r.author_name)
        .map((r: { author_name: string | null }) => (r.author_name || "").toLowerCase()),
    );
    const authorList = Array.isArray(paper.authors) ? paper.authors : (paper.authors || "").split(", ");
    for (let i = 0; i < authorList.length; i++) {
      const name = authorList[i]?.trim();
      if (name && !matchedNames.has(name.toLowerCase())) {
        authorRows.push({
          arxiv_id: paper.arxiv_id,
          author_name: name,
          first_name: name.split(/\s+/)[0] || null,
          email: null,
          is_chinese: false,
          position: authorRows.length,
        });
      }
    }

    if (authorRows.length > 0) {
      // Delete old entries for this paper, then insert fresh
      await supabase.from("paper_authors").delete().eq("arxiv_id", paper.arxiv_id);
      await supabase.from("paper_authors").insert(authorRows);
    }

    // 2b. School info lookup (from email domain)
    const schoolInfo = emailed.email ? getSchoolInfo(emailed.email) : null;
    const schoolName = schoolInfo?.name ?? null;
    const schoolTier = schoolInfo?.tier ?? null;

    // 2c. Semantic Scholar enrichment (best-effort, non-blocking)
    let s2AuthorId: string | null = null;
    let hIndex: number | null = null;
    let citationCount: number | null = null;
    let paperCount: number | null = null;
    try {
      const s2 = await lookupAuthor(paper.title, emailed.author_name);
      if (s2) {
        s2AuthorId = s2.authorId;
        hIndex = s2.hIndex;
        citationCount = s2.citationCount;
        paperCount = s2.paperCount;
      }
    } catch {
      // S2 enrichment failure is non-blocking
    }

    // 2d. Classify lead and assign rep
    let leadTier: "strong" | "normal" = "normal";
    let assignedRepId: number | null = null;
    try {
      const config = await getAssignmentConfig();
      leadTier = classifyLead(config, {
        citationCount,
        hIndex,
        schoolTier,
        authorEmail: emailed.email,
      });
      assignedRepId = assignRep(config, leadTier, emailed.email);
    } catch {
      // Classification/assignment failure is non-blocking
    }

    // 3. Upsert pipeline_lead (so dashboard has the lead)
    await supabase.from("pipeline_leads").upsert(
      {
        arxiv_id: paper.arxiv_id,
        title: paper.title,
        abstract: paper.abstract,
        authors: Array.isArray(paper.authors) ? paper.authors.join(", ") : paper.authors,
        pdf_url: paper.pdf_url,
        published_at: paper.published || null,
        author_name: emailed.author_name || null,
        author_email: emailed.email,
        first_name: emailed.first_name || null,
        school_name: schoolName,
        school_tier: schoolTier,
        compute_level: compute?.level || null,
        compute_confidence: compute?.confidence || null,
        compute_reason: compute?.reason || null,
        matched_directions: JSON.stringify(matched_directions || []),
        draft_subject: subject || null,
        // Persist the sent HTML under both fields so the drift / judge-vs-human
        // view has `draft_original_html` to judge and `draft_html` to diff
        // against edits. Python sends the same content for both since this
        // flow has no sales-edit step — if a later flow adds edits, split them.
        draft_html: body_html || null,
        draft_original_html: body_html || null,
        status: "sent",
        sent_at: new Date().toISOString(),
        source: "python_script",
        s2_author_id: s2AuthorId,
        h_index: hIndex,
        citation_count: citationCount,
        paper_count: paperCount,
        lead_tier: leadTier,
        assigned_rep_id: assignedRepId,
      },
      { onConflict: "arxiv_id" },
    );

    // 4. Record contact history
    await supabase.from("email_contact_history").upsert({
      email: emailed.email.toLowerCase(),
      paper_title: paper.title,
      subject: subject || "",
      contacted_at: new Date().toISOString(),
      source: "python_script",
    });

    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Record failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
