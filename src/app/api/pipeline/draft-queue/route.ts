import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { generateDraft } from "@/lib/email-generator";
import { getRep, classifyLead, assignRep, getAssignmentConfig } from "@/lib/assignment";
import { verifySession, AUTH_COOKIE } from "@/lib/auth";
import { lookupAuthor } from "@/lib/semantic-scholar";
import { lookupCitationsViaTavily } from "@/lib/tavily";

/**
 * GET /api/pipeline/draft-queue
 *
 * Background worker — picks up to BATCH leads with status='queued', generates
 * a draft using their assigned rep's identity, and flips to 'ready'. Designed
 * to be invoked by Vercel Cron every minute.
 *
 * Auth: Bearer $CRON_SECRET, or internal referer (same-host fetches from the
 * app itself, e.g. manual admin trigger).
 *
 * Stays well under Vercel's 60s function limit: 5 leads * ~5s Gemini = 25s.
 */
// 3 leads × (S2 ~2s + Tavily ~3s + Gemini ~5s + DB ~0.5s) ≈ 30s, below Vercel's
// 60s function limit with headroom for slow S2/Tavily responses.
const BATCH = 3;

async function checkAuth(req: NextRequest): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (secret && auth === `Bearer ${secret}`) return true;
  // Authenticated users (any role) can kick the queue from the pipeline UI.
  const session = await verifySession(req.cookies.get(AUTH_COOKIE)?.value);
  return session !== null;
}

async function processOne(row: Record<string, unknown>): Promise<boolean> {
  const id = row.id as string;
  const email = (row.author_email as string) || "";
  const title = (row.title as string) || "";

  // Optimistic claim queued → drafting. If rowcount 0, another worker got it.
  const { data: claimed } = await supabase
    .from("pipeline_leads")
    .update({ status: "drafting" })
    .eq("id", id)
    .eq("status", "queued")
    .select("id")
    .maybeSingle();
  if (!claimed) return false;

  try {
    // 1. Enrichment (S2 → Tavily) — only if we don't already have a value.
    let citationCount = (row.citation_count as number | null) ?? null;
    let hIndex = (row.h_index as number | null) ?? null;
    let s2AuthorId = (row.s2_author_id as string | null) ?? null;
    let paperCount = (row.paper_count as number | null) ?? null;

    let lookupName = (row.author_name as string | null) ?? null;
    if (!lookupName && email.includes("@")) {
      const local = email.split("@")[0];
      const guessed = local.replace(/[._\-]+/g, " ").trim();
      if (guessed.length >= 3 && /^[a-zA-Z ]+$/.test(guessed)) lookupName = guessed;
    }

    if (citationCount === null && lookupName) {
      try {
        const s2 = await lookupAuthor(title, lookupName);
        if (s2) {
          citationCount = s2.citationCount;
          hIndex = s2.hIndex;
          s2AuthorId = s2.authorId;
          paperCount = s2.paperCount;
        }
      } catch (err) {
        console.error("draft-queue S2 lookup failed", { email, err: String(err) });
      }
      if (citationCount === null) {
        try {
          const tav = await lookupCitationsViaTavily(lookupName, email);
          if (tav?.citationCount) citationCount = tav.citationCount;
        } catch { /* best-effort */ }
      }
    }

    // 2. Re-classify + re-assign if enrichment changed the picture (e.g. a
    //    high-citation author unlocked "strong" tier → routed to Leo).
    const schoolTier = (row.school_tier as number | null) ?? null;
    const mdRaw = row.matched_directions;
    const matchedDirs = typeof mdRaw === "string"
      ? mdRaw.split(",").map((s) => s.trim()).filter(Boolean)
      : Array.isArray(mdRaw) ? (mdRaw as string[]) : [];

    const config = await getAssignmentConfig();
    const newTier = classifyLead(config, { citationCount, hIndex, schoolTier, authorEmail: email });
    const newRepId = assignRep(config, newTier, email, matchedDirs);

    // 3. Look up the (possibly re-assigned) rep and generate the draft.
    const rep = await getRep(newRepId);
    const draft = await generateDraft({
      title,
      abstract: (row.abstract as string) || "",
      authorEmail: email,
      firstName: (row.first_name as string) || null,
      schoolName: (row.school_name as string) || null,
      schoolTier,
      matchedDirections: matchedDirs,
      repName: rep?.sender_name,
      repWechatId: rep?.wechat_id,
    });

    await supabase
      .from("pipeline_leads")
      .update({
        citation_count: citationCount,
        h_index: hIndex,
        s2_author_id: s2AuthorId,
        paper_count: paperCount,
        lead_tier: newTier,
        assigned_rep_id: newRepId,
        draft_subject: draft.subject,
        draft_html: draft.html,
        status: "ready",
      })
      .eq("id", id);
    return true;
  } catch (err) {
    console.error("draft-queue failed", { id, err: String(err) });
    // Roll back to queued so the next run retries.
    await supabase
      .from("pipeline_leads")
      .update({ status: "queued" })
      .eq("id", id);
    return false;
  }
}

async function run() {
  const { data: queued } = await supabase
    .from("pipeline_leads")
    .select(
      "id, title, abstract, author_email, author_name, first_name, school_name, school_tier, matched_directions, assigned_rep_id, citation_count, h_index, s2_author_id, paper_count"
    )
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(BATCH);

  if (!queued || queued.length === 0) {
    return { processed: 0, remaining: 0 };
  }

  let processed = 0;
  for (const row of queued) {
    const ok = await processOne(row);
    if (ok) processed++;
  }

  const { count: remaining } = await supabase
    .from("pipeline_leads")
    .select("*", { count: "exact", head: true })
    .eq("status", "queued");

  return { processed, remaining: remaining ?? 0 };
}

export async function GET(req: NextRequest) {
  if (!(await checkAuth(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await run();
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "draft-queue failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  return GET(req);
}
