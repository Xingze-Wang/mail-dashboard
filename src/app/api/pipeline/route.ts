import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { scanArxiv, type ScannedLead } from "@/lib/scanner";
import { generateDraft } from "@/lib/email-generator";
import { lookupAuthor } from "@/lib/semantic-scholar";
import {
  getAssignmentConfig,
  classifyLead,
  assignRep,
  getRep,
  resolveCategory,
} from "@/lib/assignment";

// ─── Shared field mapper ────────────────────────────────────────────────────

/** Parse matched_directions from DB (may be JSON array string or comma-separated). */
function parseDirections(raw: unknown): string[] {
  if (!raw || typeof raw !== "string") return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed);
      return Array.isArray(arr) ? arr.map(String) : [];
    } catch {
      // fall through to comma split
    }
  }
  return trimmed.split(",").map((s: string) => s.trim()).filter(Boolean);
}

function mapLead(l: Record<string, unknown>) {
  const directions = parseDirections(l.matched_directions);
  return {
    id: l.id,
    arxivId: l.arxiv_id,
    title: l.title,
    abstract: l.abstract,
    authors: l.authors,
    pdfUrl: l.pdf_url,
    publishedAt: l.published_at,
    authorName: l.author_name,
    authorEmail: l.author_email,
    firstName: l.first_name,
    schoolName: l.school_name,
    schoolTier: l.school_tier,
    computeLevel: l.compute_level,
    computeConfidence: l.compute_confidence,
    computeReason: l.compute_reason,
    matchedDirections: l.matched_directions,
    category: resolveCategory(directions),
    draftSubject: l.draft_subject,
    draftHtml: l.draft_html,
    status: l.status,
    sentAt: l.sent_at,
    createdAt: l.created_at,
    s2AuthorId: l.s2_author_id,
    hIndex: l.h_index,
    citationCount: l.citation_count,
    paperCount: l.paper_count,
    leadTier: l.lead_tier,
    assignedRepId: l.assigned_rep_id,
  };
}

// ─── GET: list leads with filters ───────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "50");
  const status = searchParams.get("status");
  const tier = searchParams.get("tier");
  const repId = searchParams.get("rep_id");
  const category = searchParams.get("category");
  const dateRange = searchParams.get("date"); // "today" | "week" | "all"
  const offset = (page - 1) * limit;

  let query = supabase
    .from("pipeline_leads")
    .select("*")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  let countQuery = supabase
    .from("pipeline_leads")
    .select("*", { count: "exact", head: true });

  if (status) {
    query = query.eq("status", status);
    countQuery = countQuery.eq("status", status);
  }
  if (tier) {
    query = query.eq("lead_tier", tier);
    countQuery = countQuery.eq("lead_tier", tier);
  }
  if (repId) {
    query = query.eq("assigned_rep_id", parseInt(repId));
    countQuery = countQuery.eq("assigned_rep_id", parseInt(repId));
  }
  if (dateRange === "today") {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    query = query.gte("created_at", todayStart.toISOString());
    countQuery = countQuery.gte("created_at", todayStart.toISOString());
  } else if (dateRange === "week") {
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    weekAgo.setHours(0, 0, 0, 0);
    query = query.gte("created_at", weekAgo.toISOString());
    countQuery = countQuery.gte("created_at", weekAgo.toISOString());
  }

  const [{ data: leads }, { count: total }] = await Promise.all([
    query,
    countQuery,
  ]);

  let mapped = (leads || []).map(mapLead);

  // Client-side category filter (category is derived, not a DB column)
  if (category) {
    mapped = mapped.filter((l) => l.category === category);
  }

  return NextResponse.json({
    leads: mapped,
    total: category ? mapped.length : (total || 0),
    page,
    limit,
  });
}

// ─── POST: scan arXiv → enrich → classify → assign → draft ─────────────────

async function insertLead(
  lead: ScannedLead,
  draft: { subject: string; html: string } | null,
  extras: {
    s2AuthorId?: string | null;
    hIndex?: number | null;
    citationCount?: number | null;
    paperCount?: number | null;
    leadTier?: string;
    assignedRepId?: number;
  },
) {
  return supabase.from("pipeline_leads").insert({
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
    s2_author_id: extras.s2AuthorId ?? null,
    h_index: extras.hIndex ?? null,
    citation_count: extras.citationCount ?? null,
    paper_count: extras.paperCount ?? null,
    lead_tier: extras.leadTier ?? "normal",
    assigned_rep_id: extras.assignedRepId ?? null,
  });
}

export async function POST(req: NextRequest) {
  const isVercelCron =
    req.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
  const referer = req.headers.get("referer") || "";
  const host = req.headers.get("host") || "__none__";
  const isInternal = referer.includes(host);

  if (process.env.CRON_SECRET && !isVercelCron && !isInternal) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { leads, stats } = await scanArxiv();
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
          repName: rep?.name,
          repWechatId: rep?.wechat_id,
        });
      } catch {
        // Draft generation failed — insert with status 'new'
      }

      // 5. Insert with enrichment data
      const { error } = await insertLead(lead, draft, {
        s2AuthorId: s2?.authorId ?? null,
        hIndex: s2?.hIndex ?? null,
        citationCount: s2?.citationCount ?? null,
        paperCount: s2?.paperCount ?? null,
        leadTier: tier,
        assignedRepId: repId,
      });
      if (!error) leadsCreated++;
    }

    return NextResponse.json({ stats, leadsCreated });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Pipeline scan failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
