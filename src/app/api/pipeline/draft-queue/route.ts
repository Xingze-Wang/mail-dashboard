import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { generateDraft } from "@/lib/email-generator";
import { getRep } from "@/lib/assignment";
import { verifySession, AUTH_COOKIE } from "@/lib/auth";

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
const BATCH = 5;

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
  const assignedRepId = row.assigned_rep_id as number | null;

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
    const rep = assignedRepId ? await getRep(assignedRepId) : null;
    const mdRaw = row.matched_directions;
    const matchedDirs = typeof mdRaw === "string"
      ? mdRaw.split(",").map((s) => s.trim()).filter(Boolean)
      : Array.isArray(mdRaw) ? (mdRaw as string[]) : [];

    const draft = await generateDraft({
      title: (row.title as string) || "",
      abstract: (row.abstract as string) || "",
      authorEmail: (row.author_email as string) || "",
      firstName: (row.first_name as string) || null,
      schoolName: (row.school_name as string) || null,
      schoolTier: (row.school_tier as number | null) ?? null,
      matchedDirections: matchedDirs,
      repName: rep?.sender_name,
      repWechatId: rep?.wechat_id,
    });

    await supabase
      .from("pipeline_leads")
      .update({
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
    .select("id, title, abstract, author_email, first_name, school_name, school_tier, matched_directions, assigned_rep_id")
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
