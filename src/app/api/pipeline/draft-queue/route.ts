import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { generateDraft, normalizeMatchedDirections } from "@/lib/email-generator";
import { validateDraft } from "@/lib/draft-validator";
import { validateEmailStructure } from "@/lib/email-structural-qc";
import { rewriteDraftIntro } from "@/lib/draft-rewrite";
import { getRep, classifyLead, assignRep, getAssignmentConfig } from "@/lib/assignment";
import { verifySession, AUTH_COOKIE } from "@/lib/auth";
import { lookupAuthor } from "@/lib/semantic-scholar";
import { scoreWithGemini } from "@/lib/gemini-scorer";

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
// Drain up to 30 leads per invocation. maxDuration is 300s (Pro
// limit). At ~5s/lead (S2 + LLM + DB) that's 150s — comfortably under.
// Combined with a dedicated cron schedule that fires every 10 min on
// weekdays (vercel.json), worst-case daily drain ≈ 30 * 6 * 24 = 4,320,
// which is way more than the ~80/day Python ingest. Backlog drains in
// under a day even when starting from 1,500+.
const BATCH = 30;
export const maxDuration = 300;

async function checkAuth(req: NextRequest): Promise<boolean> {
  // Accept: (a) Vercel cron signal (set by Vercel when a cron schedule
  // fires this route directly OR when /api/cron fans out via internal
  // fetch — Vercel adds the header itself for genuine cron traffic),
  // (b) Bearer $CRON_SECRET (manual cron triggers from scripts), or
  // (c) an authenticated admin session (manual drain from /pipeline).
  // The Vercel cron header path is what makes this work reliably — env
  // var comparisons can break across runtime/env decoding, the header
  // can't be forged from outside.
  if (req.headers.get("x-vercel-cron") === "1") return true;

  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (secret && auth === `Bearer ${secret}`) return true;

  const session = await verifySession(req.cookies.get(AUTH_COOKIE)?.value);
  if (!session) return false;
  return session.role === "admin";
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
      // Tavily fallback was here — dropped. When S2 misses, classify now
      // falls through to local_score (sentence-transformer trained F1=0.88)
      // which is a better signal than a scraped Scholar page.
    }

    // 1b. Score with Gemini when Python didn't supply a local_score.
    // Python's trained classifier (sentence-transformer, F1=0.88) is the
    // canonical signal; this is a stopgap for leads inserted via scan /
    // manual add / discovery-promote, which don't run through resend0412.py.
    let localScore: number | null = (row.local_score as number | null) ?? null;
    if (localScore === null && title) {
      try {
        const g = await scoreWithGemini(title, (row.abstract as string) || "");
        if (g !== null) localScore = g;
      } catch {
        // non-blocking
      }
    }

    // 2. Re-classify (enrichment may bump tier — e.g. high citations
    //    unlock "strong"). Rep assignment is NOT re-computed here under
    //    the shared-pool model — assigned_rep_id is set by the allocator
    //    (/api/missions/allocate-leads) at 09:00 Beijing daily. Draft-queue
    //    only processes leads that are already assigned (filtered in run()).
    const schoolTier = (row.school_tier as number | null) ?? null;
    // matched_directions is Python-written JSON-string or proper array.
    // normalizeMatchedDirections handles both (without it, JSON-stringified
    // arrays leaked as `["具身..."]` raw escapes into email body).
    const matchedDirs = normalizeMatchedDirections(row.matched_directions);

    const config = await getAssignmentConfig();
    const newTier = classifyLead(config, { citationCount, hIndex, schoolTier, authorEmail: email, localScore });
    // Use the rep that the allocator already assigned. If somehow null at
    // this point (shouldn't happen given the run() filter), bail — the
    // allocator hasn't claimed this lead yet.
    const newRepId = (row.assigned_rep_id as number | null) ?? null;
    if (newRepId == null) {
      // Roll back to queued so the next run retries after allocation.
      await supabase
        .from("pipeline_leads")
        .update({ status: "queued" })
        .eq("id", id);
      return false;
    }
    // assignRep import retained for the admin auto-route path elsewhere;
    // explicitly silence the unused-binding lint here.
    void assignRep;

    // 3. Look up the assigned rep and generate the draft.
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
      assignedRepId: newRepId,
      // Pass lead.id so loadEffectiveTemplate can do deterministic
      // A/B routing (active vs approved_draft).
      leadId: id,
    });

    // ── QUALITY GATE LAYER 1 — legacy draft-validator (LLM-meta leaks,
    // truncated intros, missing signature). Keeps its existing behavior:
    // hard failure rolls back to `queued` for next-cron retry. This catches
    // the "LLM clearly broke" class.
    const validation = validateDraft({
      subject: draft.subject,
      html: draft.html,
      introOutput: draft.introOutput,
    });
    if (!validation.ok) {
      console.warn("draft-queue quality gate (legacy) failed", {
        id,
        issues: validation.hard.map((h) => h.key),
      });
      await supabase.from("pipeline_leads").update({ status: "queued" }).eq("id", id);
      return false;
    }

    // ── QUALITY GATE LAYER 2 — structural lock (migration 103).
    // Catches a stricter class of failures (CoT leak markers, Gemini error
    // string in body, banned symbols, block count broken, intro missing
    // the 算力 hook, etc). On hard failure we try LLM-driven rewrite up to
    // 2 attempts before quarantining.
    let finalHtml = draft.html;
    let finalIntro = draft.introOutput ?? "";
    let qcRetryCount = 0;
    const qcHistory: Array<Record<string, unknown>> = [];
    let qc = validateEmailStructure({
      subject: draft.subject,
      html: finalHtml,
      queueMode: true,
    });

    if (!qc.ok) {
      const rewrite = await rewriteDraftIntro({
        html: finalHtml,
        subject: draft.subject,
        title,
        abstract: (row.abstract as string) || "",
        previousIntro: finalIntro,
        hard: qc.hard,
      });
      qcRetryCount = rewrite.attempts.length;
      for (const a of rewrite.attempts) {
        qcHistory.push({
          ts: new Date().toISOString(),
          attempt: a.attempt,
          ok: a.ok,
          intro_before: finalIntro,
          intro_after: a.newIntro,
          qc_codes_after: a.qcCodesAfter,
          error_message: a.errorMessage ?? null,
        });
      }
      if (rewrite.ok) {
        finalHtml = rewrite.finalHtml;
        finalIntro = rewrite.finalIntro;
        qc = validateEmailStructure({ subject: draft.subject, html: finalHtml, queueMode: true });
      } else {
        // Rewrite exhausted (or non-rewritable hard failure like
        // BLOCK_COUNT / SUBJECT_PREFIX). Quarantine the lead and bail.
        console.warn("draft-queue structural QC failed, quarantining", {
          id,
          hard: qc.hard.map((h) => h.code),
          rewrite_reason: rewrite.reason,
          attempts: rewrite.attempts.length,
        });
        await supabase
          .from("pipeline_leads")
          .update({
            status: "qc_quarantined",
            qc_verdict: qc,
            qc_retry_count: qcRetryCount,
            qc_history: qcHistory,
            // Keep draft_html so admin can see what was generated and decide
            draft_subject: draft.subject,
            draft_html: finalHtml,
            draft_intro_prompt_resolved: draft.introPromptResolved ?? null,
            draft_intro_output: finalIntro,
          })
          .eq("id", id);
        return false;
      }
    }

    await supabase
      .from("pipeline_leads")
      .update({
        citation_count: citationCount,
        h_index: hIndex,
        s2_author_id: s2AuthorId,
        paper_count: paperCount,
        local_score: localScore,
        lead_tier: newTier,
        assigned_rep_id: newRepId,
        draft_subject: draft.subject,
        draft_html: finalHtml,
        // Capture the LLM prompt + output that produced this intro
        // (migration 062). Lead-bound; survives reassignment unchanged.
        draft_intro_prompt_resolved: draft.introPromptResolved ?? null,
        draft_intro_output: finalIntro,
        // Snapshot for diff mining (frozen even as sales edits).
        draft_original_subject: draft.subject,
        draft_original_html: finalHtml,
        draft_model: "server-gemini",
        // New in mig 103 — structural QC verdict captured at save-to-ready time
        qc_verdict: qc,
        qc_retry_count: qcRetryCount,
        qc_history: qcHistory.length > 0 ? qcHistory : null,
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
  // Only draft for leads that have already been assigned by the allocator.
  // Unassigned 'queued' leads sit in the pool until /api/missions/allocate-leads
  // claims them. This guard is what makes the shared-pool model work — without
  // it, draft-queue would silently re-assign every lead and undo Phase 2.
  const { data: queued } = await supabase
    .from("pipeline_leads")
    .select(
      "id, title, abstract, author_email, author_name, first_name, school_name, school_tier, matched_directions, assigned_rep_id, citation_count, h_index, s2_author_id, paper_count, local_score"
    )
    .eq("status", "queued")
    .not("assigned_rep_id", "is", null)
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
