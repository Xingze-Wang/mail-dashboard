import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";

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
    const body = await req.json();
    const { paper, emailed, all_authors, compute, matched_directions, subject } = body;

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
        compute_level: compute?.level || null,
        compute_confidence: compute?.confidence || null,
        compute_reason: compute?.reason || null,
        matched_directions: JSON.stringify(matched_directions || []),
        draft_subject: subject || null,
        status: "sent",
        sent_at: new Date().toISOString(),
        source: "python_script",
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
