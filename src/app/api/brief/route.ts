import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

/**
 * GET /api/brief?name=jiahao     — search by name (WeChat scenario)
 * GET /api/brief?email=xx@yy.edu — search by email (emails page scenario)
 *
 * Search strategy (in order):
 *  1. pipeline_leads: first_name, author_name, author_email, authors text
 *  2. paper_authors: first_name, author_name (covers ALL co-authors)
 *     → joins to papers table for paper info, then to pipeline_leads for outreach info
 *
 * This two-layer search means: even if we emailed 二作, when 一作 comes on WeChat,
 * we find them via paper_authors and link back to the paper + lead.
 */

function parseDirections(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return raw.split(",").map((d) => d.trim());
  }
}

interface BriefResult {
  id: string | null;
  personName: string;
  firstName: string | null;
  paper: {
    title: string;
    arxivId: string;
    pdfUrl: string | null;
    abstract: string | null;
    authors: string | null;
    publishedAt: string | null;
  } | null;
  research: {
    computeLevel: string | null;
    computeConfidence: number | null;
    computeReason: string | null;
    directions: string[];
    schoolName: string | null;
    schoolTier: number | null;
  };
  outreach: {
    emailedTo: string | null;
    emailedName: string | null;
    subject: string | null;
    status: string | null;
    sentAt: string | null;
  };
  authorMismatch: {
    note: string;
    emailedPerson: string;
    searchedPerson: string;
  } | null;
  matchTypes: string[];
  createdAt: string;
  source?: "pipeline_lead" | "paper_author" | "email-only";
}

// Infer a display name from an email address. We only use this when
// pipeline_leads has no row for this email (legacy emails sent before
// pipeline_leads was wired up). The local part with separators stripped
// gives us a reasonable label like "John Smith" from "john.smith@x.edu".
function inferNameFromEmail(email: string): string {
  const local = email.split("@")[0] || "";
  if (!local) return "(unknown)";
  const cleaned = local
    .replace(/[._\-+]+/g, " ")
    .replace(/\d+/g, "")
    .trim();
  if (!cleaned) return "(unknown)";
  return cleaned
    .split(/\s+/)
    .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export async function GET(req: NextRequest) {
  // Auth required — the response surfaces full lead data (author
  // emails, drafts, outreach history) which was previously publicly
  // queryable. Note: brief search is deliberately cross-rep (any rep
  // can look up any person for WeChat follow-up), but must still
  // require a valid session.
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const name = searchParams.get("name")?.trim();
  const email = searchParams.get("email")?.trim();

  if (!name && !email) {
    return NextResponse.json(
      { error: "Provide name or email parameter" },
      { status: 400 },
    );
  }

  // Use arxiv_id as dedup key (one brief per paper)
  const results = new Map<string, BriefResult>();

  // ─── Layer 1: Search pipeline_leads (existing leads we've processed) ────

  if (email) {
    const { data } = await supabase
      .from("pipeline_leads")
      .select("*")
      .ilike("author_email", email.toLowerCase())
      .order("created_at", { ascending: false })
      .limit(10);

    for (const l of data ?? []) {
      results.set(l.arxiv_id, buildFromLead(l, ["email"], email));
    }
  }

  if (name && name.length >= 2) {
    const nameLower = name.toLowerCase();

    const [
      { data: byFirstName },
      { data: byAuthorName },
      { data: byAuthors },
    ] = await Promise.all([
      supabase
        .from("pipeline_leads")
        .select("*")
        .ilike("first_name", nameLower)
        .order("created_at", { ascending: false })
        .limit(20),
      supabase
        .from("pipeline_leads")
        .select("*")
        .ilike("author_name", `%${nameLower}%`)
        .order("created_at", { ascending: false })
        .limit(20),
      supabase
        .from("pipeline_leads")
        .select("*")
        .ilike("authors", `%${nameLower}%`)
        .order("created_at", { ascending: false })
        .limit(20),
    ]);

    for (const l of byFirstName ?? []) {
      if (!results.has(l.arxiv_id)) {
        results.set(l.arxiv_id, buildFromLead(l, ["first_name"], name));
      }
    }
    for (const l of byAuthorName ?? []) {
      if (!results.has(l.arxiv_id)) {
        results.set(l.arxiv_id, buildFromLead(l, ["author_name"], name));
      }
    }
    for (const l of byAuthors ?? []) {
      if (!results.has(l.arxiv_id)) {
        results.set(l.arxiv_id, buildFromLead(l, ["co_author"], name));
      }
    }

    // ─── Layer 2: Search paper_authors table (all authors, not just the one we emailed) ──
    const [
      { data: paByFirst },
      { data: paByName },
    ] = await Promise.all([
      supabase
        .from("paper_authors")
        .select("arxiv_id, author_name, first_name, email, position")
        .ilike("first_name", nameLower)
        .limit(20),
      supabase
        .from("paper_authors")
        .select("arxiv_id, author_name, first_name, email, position")
        .ilike("author_name", `%${nameLower}%`)
        .limit(20),
    ]);

    // Collect arxiv_ids we haven't already found via pipeline_leads
    const paperAuthorHits = new Map<string, { authorName: string | null; firstName: string | null; position: number }>();
    for (const pa of [...(paByFirst ?? []), ...(paByName ?? [])]) {
      if (!results.has(pa.arxiv_id) && !paperAuthorHits.has(pa.arxiv_id)) {
        paperAuthorHits.set(pa.arxiv_id, {
          authorName: pa.author_name,
          firstName: pa.first_name,
          position: pa.position ?? 999,
        });
      }
    }

    if (paperAuthorHits.size > 0) {
      const arxivIds = Array.from(paperAuthorHits.keys());

      // Fetch paper details
      const { data: papers } = await supabase
        .from("papers")
        .select("*")
        .in("arxiv_id", arxivIds);

      // Try to find corresponding pipeline_leads
      const { data: leads } = await supabase
        .from("pipeline_leads")
        .select("*")
        .in("arxiv_id", arxivIds);

      const leadsByArxiv = new Map<string, Record<string, unknown>>();
      for (const l of leads ?? []) {
        leadsByArxiv.set(l.arxiv_id as string, l);
      }

      for (const p of papers ?? []) {
        const hit = paperAuthorHits.get(p.arxiv_id as string);
        const lead = leadsByArxiv.get(p.arxiv_id as string);

        const brief: BriefResult = {
          id: (lead?.id as string) || (p.arxiv_id as string),
          personName: (hit?.authorName as string) || name,
          firstName: (hit?.firstName as string) || null,
          paper: {
            title: p.title as string,
            arxivId: p.arxiv_id as string,
            pdfUrl: (p.pdf_url as string) || null,
            abstract: (p.abstract as string) || null,
            authors: (p.authors as string) || null,
            publishedAt: (p.published_at as string) || null,
          },
          research: {
            computeLevel: ((lead?.compute_level ?? p.compute_level) as string) || null,
            computeConfidence: ((lead?.compute_confidence ?? p.compute_confidence) as number) || null,
            computeReason: ((lead?.compute_reason ?? p.compute_reason) as string) || null,
            directions: parseDirections(
              ((lead?.matched_directions ?? p.matched_directions) as string) || null,
            ),
            schoolName: (lead?.school_name as string) || null,
            schoolTier: (lead?.school_tier as number) || null,
          },
          outreach: lead
            ? {
                emailedTo: lead.author_email as string,
                emailedName: lead.author_name as string | null,
                subject: lead.draft_subject as string | null,
                status: lead.status as string,
                sentAt: lead.sent_at as string | null,
              }
            : { emailedTo: null, emailedName: null, subject: null, status: null, sentAt: null },
          authorMismatch: lead
            ? {
                note: `We emailed ${lead.author_name || lead.author_email}, but "${name}" (position ${(hit?.position ?? 0) + 1} in author list) found us. They are a co-author on this paper.`,
                emailedPerson: (lead.author_name || lead.author_email) as string,
                searchedPerson: name,
              }
            : null,
          matchTypes: ["paper_author"],
          createdAt: (p.created_at as string) || new Date().toISOString(),
          source: "paper_author",
        };

        results.set(p.arxiv_id as string, brief);
      }
    }
  }

  const briefs = Array.from(results.values());

  // Sort: direct matches first, then co-author/paper_author matches; newest first
  briefs.sort((a, b) => {
    const aScore = a.authorMismatch ? 0 : 1;
    const bScore = b.authorMismatch ? 0 : 1;
    if (aScore !== bScore) return bScore - aScore;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  // ─── Fallback: synthetic brief for legacy emails ────────────────────────
  // When the lookup is by email and we found no pipeline_lead / paper_author
  // match, return a minimal "email-only" brief so the sidebar can still render
  // a useful card and (critically) show the WeChat conversion button. This
  // covers emails sent through the old Python paths before pipeline_leads
  // was wired up — there's no lead row, but the rep still wants to mark
  // the WeChat conversion.
  if (briefs.length === 0 && email) {
    const synthetic: BriefResult = {
      id: null,
      personName: inferNameFromEmail(email),
      firstName: null,
      paper: null,
      research: {
        computeLevel: null,
        computeConfidence: null,
        computeReason: null,
        directions: [],
        schoolName: null,
        schoolTier: null,
      },
      outreach: {
        emailedTo: email,
        emailedName: null,
        subject: null,
        status: null,
        sentAt: null,
      },
      authorMismatch: null,
      matchTypes: [],
      createdAt: new Date().toISOString(),
      source: "email-only",
    };
    briefs.push(synthetic);
  }

  return NextResponse.json({
    query: name || email,
    count: briefs.length,
    briefs,
  });
}

// ─── Helper: build brief from a pipeline_leads row ─────────────────────────

function buildFromLead(
  l: Record<string, unknown>,
  matchTypes: string[],
  searchTerm: string,
): BriefResult {
  const isDirectContact =
    matchTypes.includes("first_name") ||
    matchTypes.includes("author_name") ||
    matchTypes.includes("email");
  const isCo = !isDirectContact;

  return {
    id: l.id as string,
    personName: isCo ? searchTerm : (l.author_name as string) || searchTerm,
    firstName: l.first_name as string | null,
    paper: {
      title: l.title as string,
      arxivId: l.arxiv_id as string,
      pdfUrl: (l.pdf_url as string) || null,
      abstract: (l.abstract as string) || null,
      authors: (l.authors as string) || null,
      publishedAt: (l.published_at as string) || null,
    },
    research: {
      computeLevel: (l.compute_level as string) || null,
      computeConfidence: (l.compute_confidence as number) || null,
      computeReason: (l.compute_reason as string) || null,
      directions: parseDirections((l.matched_directions as string) || null),
      schoolName: (l.school_name as string) || null,
      schoolTier: (l.school_tier as number) || null,
    },
    outreach: {
      emailedTo: l.author_email as string,
      emailedName: (l.author_name as string) || null,
      subject: (l.draft_subject as string) || null,
      status: l.status as string,
      sentAt: (l.sent_at as string) || null,
    },
    authorMismatch: isCo
      ? {
          note: `We emailed ${l.author_name || l.author_email}, but "${searchTerm}" is a co-author on this paper.`,
          emailedPerson: (l.author_name || l.author_email) as string,
          searchedPerson: searchTerm,
        }
      : null,
    matchTypes,
    createdAt: l.created_at as string,
    source: "pipeline_lead",
  };
}
