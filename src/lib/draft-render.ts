// Shared "render a draft for this rep" pipeline.
//
// Same primitive used by:
//   1. /api/missions/allocate-leads (morning allocator) — runs at 09:00
//      Beijing when a lead is first bound to a rep. Per-rep templates
//      only resolve correctly once a rep_id exists on the lead.
//   2. /api/pipeline/draft-queue (background worker fan-out) — picks
//      up leftover 'queued' rows whose assembly failed in step 1.
//
// Before this module existed, only the draft-queue worker ran assembly,
// and the worker had no scheduler — leading to a 1500-row backlog where
// `assigned_rep_id` was set but draft_html was the Python baseline, not
// the rep's actual template. Moving assembly into the allocator closes
// that gap: every assigned lead has its final draft within seconds.
//
// `renderDraftsForRep` is a thin orchestrator — the per-lead work
// remains in draft-queue's processOne for now (claim → enrich → assemble
// → ready). Future: lift processOne here and have draft-queue's route
// just call this in a loop.

import { supabase } from "@/lib/db";
import { generateDraft } from "@/lib/email-generator";
import { lookupAuthor } from "@/lib/semantic-scholar";
import { scoreWithGemini } from "@/lib/gemini-scorer";
import { getRep, classifyLead, getAssignmentConfig } from "@/lib/assignment";

/** Render the final draft for each lead under this rep's identity +
 *  effective template, then flip status='ready'. Idempotent: any lead
 *  not currently in 'queued' or 'new' is skipped (won't clobber 'sent'). */
export async function renderDraftsForRep(repId: number, leadIds: readonly string[]): Promise<{ rendered: number; failed: number }> {
  if (leadIds.length === 0) return { rendered: 0, failed: 0 };

  const rep = await getRep(repId);
  if (!rep) {
    console.error(`[draft-render] getRep(${repId}) returned null — bailing`);
    return { rendered: 0, failed: leadIds.length };
  }

  const config = await getAssignmentConfig();
  let rendered = 0;
  let failed = 0;

  // Fetch all leads in one shot
  const { data: rows, error } = await supabase
    .from("pipeline_leads")
    .select(
      "id, title, abstract, author_email, author_name, first_name, school_name, school_tier, matched_directions, citation_count, h_index, s2_author_id, paper_count, local_score, status",
    )
    .in("id", leadIds as string[]);
  if (error || !rows) {
    console.error(`[draft-render] fetch failed: ${error?.message}`);
    return { rendered: 0, failed: leadIds.length };
  }

  for (const row of rows) {
    // Only render leads that are still in queued/new. Don't touch
    // 'sent' / 'replied' / 'skipped' — they have terminal state.
    if (row.status !== "queued" && row.status !== "new") continue;

    const id = row.id as string;
    const email = (row.author_email as string) || "";
    const title = (row.title as string) || "";

    try {
      // Enrichment (only if missing) — copied from draft-queue/processOne.
      // S2 lookup → classify → assemble. Tavily was deprecated.
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
        } catch {}
      }

      // local_score fallback when Python didn't supply one.
      let localScore: number | null = (row.local_score as number | null) ?? null;
      if (localScore === null && title) {
        try {
          const g = await scoreWithGemini(title, (row.abstract as string) || "");
          if (g !== null) localScore = g;
        } catch {}
      }

      const schoolTier = (row.school_tier as number | null) ?? null;
      const mdRaw = row.matched_directions;
      const matchedDirs =
        typeof mdRaw === "string"
          ? mdRaw.split(",").map((s) => s.trim()).filter(Boolean)
          : Array.isArray(mdRaw) ? (mdRaw as string[]) : [];

      const newTier = classifyLead(config, {
        citationCount,
        hIndex,
        schoolTier,
        authorEmail: email,
        localScore,
      });

      const draft = await generateDraft({
        title,
        abstract: (row.abstract as string) || "",
        authorEmail: email,
        firstName: (row.first_name as string) || null,
        schoolName: (row.school_name as string) || null,
        schoolTier,
        matchedDirections: matchedDirs,
        repName: rep.sender_name,
        repWechatId: rep.wechat_id,
        assignedRepId: repId,
        leadId: id,
      });

      await supabase
        .from("pipeline_leads")
        .update({
          citation_count: citationCount,
          h_index: hIndex,
          s2_author_id: s2AuthorId,
          paper_count: paperCount,
          local_score: localScore,
          lead_tier: newTier,
          draft_subject: draft.subject,
          draft_html: draft.html,
          draft_intro_prompt_resolved: draft.introPromptResolved ?? null,
          draft_intro_output: draft.introOutput ?? null,
          draft_original_subject: draft.subject,
          draft_original_html: draft.html,
          draft_model: "server-allocator",
          status: "ready",
        })
        .eq("id", id);
      rendered++;
    } catch (err) {
      console.error(`[draft-render] failed lead=${id}: ${String(err).slice(0, 200)}`);
      failed++;
    }
  }

  return { rendered, failed };
}
