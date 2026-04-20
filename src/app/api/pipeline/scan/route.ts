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
} from "@/lib/assignment";

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

function checkAuth(req: NextRequest): boolean {
  const isVercelCron = req.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
  const referer = req.headers.get("referer") || "";
  const host = req.headers.get("host") || "__none__";
  const isInternal = referer.includes(host);

  if (process.env.CRON_SECRET && !isVercelCron && !isInternal) {
    return false;
  }
  return true;
}

async function ensureTable() {
  // Check if table exists by trying a select
  const { error } = await supabase.from("pipeline_leads").select("id").limit(1);
  if (error?.message?.includes("pipeline_leads")) {
    // Table doesn't exist — create it via raw SQL
    // First ensure the _exec_sql helper function exists
    await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/_exec_sql`, {
      method: "POST",
      headers: {
        apikey: process.env.SUPABASE_SERVICE_KEY!,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY!}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sql_text: `create table if not exists pipeline_leads (
          id text primary key default gen_random_uuid()::text,
          arxiv_id text unique not null, title text not null, abstract text,
          authors text, pdf_url text, published_at timestamptz,
          author_name text, author_email text not null, first_name text,
          school_name text, school_tier int, compute_level text,
          compute_confidence float, compute_reason text, matched_directions text,
          draft_subject text, draft_html text,
          status text not null default 'new', source text not null default 'arxiv',
          created_at timestamptz not null default now(), sent_at timestamptz
        ); create index if not exists idx_pipeline_status on pipeline_leads(status);
        create index if not exists idx_pipeline_email on pipeline_leads(author_email);`,
      }),
    });
  }
}

async function runScan() {
  await ensureTable();
  const { leads, stats } = await scanArxiv({ maxPapers: 50, timeBudgetMs: 120000 });
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
    const repId = assignRep(config, tier, lead.authorEmail, lead.matchedDirections);

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
    if (error) {
      stats.errors.push(`insert ${lead.arxivId}: ${error.message}`);
    } else {
      leadsCreated++;
    }
  }

  return { stats, leadsCreated };
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runScan();
    return NextResponse.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Scan failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runScan();
    return NextResponse.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Scan failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
