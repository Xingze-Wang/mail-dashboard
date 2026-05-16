// One-stop enrichment + templating primitive for a pipeline_leads row.
//
// Called at import time (POST /api/pipeline/import) so every lead is
// enriched + templated BEFORE it sits in the pool waiting for the
// morning allocator. The allocator does NOT re-run this — it just
// stamps assigned_rep_id and (currently) re-templates with the rep's
// effective template at allocation time (see src/lib/draft-render.ts).
//
// Each enrichment step is best-effort. Failure of one doesn't block
// the others. The function returns a delta object that the caller
// either merges onto the row before insert, or UPDATEs after insert.
//
// Sources, in order of cost:
//   1. school_tier — local lookup from author_email domain (cheap,
//      SCHOOL_DATA in scanner-config). Only fills when missing.
//   2. S2 author lookup — h_index / citation_count / paper_count /
//      s2_author_id + industry_orgs detection from affiliations.
//   3. HF / GitHub repo extraction from abstract (paper-side, regex).
//      Stored on the lead via the existing `hf_repo` / `github_repo`
//      columns on pipeline_leads? — currently those columns live on
//      the `papers` table (migration 036), not pipeline_leads. We
//      RETURN the extracted repos so the caller can attach them to a
//      papers row if it wants, but the import route doesn't write
//      paper-side data today. Keep the extracted values on the delta
//      under hf_repo / github_repo for forward-compat; persistence is
//      a no-op until a column lands.
//   4. Person resolution — find-or-create persons row, link via
//      person_id.
//
// NOT in scope (separate cron):
//   - Bulk re-enrichment of historical leads (use enrich-h-index for
//     h_index; bench-inverted-lookup.mjs for HF backfill).
//   - LLM-driven enrichment (intent detection, summarization).
//
// Templating: see assembleDraftAtImport() below. It runs the org-wide
// global template (loadEffectiveTemplate(null, leadId)) and returns
// {subject, html, intro_prompt_resolved, intro_output}. Rep-specific
// placeholders ({{REP_NAME}}, {{REP_WECHAT}}, {{CLOSING_NAME}}) stay
// as sentinels — resolveLatePlaceholders fills them at send time.

import { lookupAuthor } from "@/lib/semantic-scholar";
import { resolvePerson } from "@/lib/person-resolver";
import { extractFromText } from "@/lib/repo-extractor";
import { detectOrgs } from "@/lib/industry-orgs";
import {
  loadEffectiveTemplate,
  assembleDraft,
} from "@/lib/template-assembler";
import { generateDraft } from "@/lib/email-generator";
import { supabase } from "@/lib/db";

export interface LeadEnrichmentInput {
  /** pipeline_leads.id — used for deterministic A/B template split. */
  lead_id: string;
  title: string;
  abstract: string | null;
  author_name: string | null;
  author_email: string;
  first_name?: string | null;
  school_name?: string | null;
  school_tier?: number | null;
  matched_directions?: string | string[] | null;
  /** Pre-existing values on the row — used to short-circuit fields
   *  that are already populated (e.g. Python supplied h_index). */
  existing?: {
    s2_author_id?: string | null;
    h_index?: number | null;
    citation_count?: number | null;
    paper_count?: number | null;
    person_id?: string | null;
    industry_orgs?: string[] | null;
  };
  /** Optional arxiv id — used in the future for paper-side HF/GH
   *  fallback (huggingface.co/papers/<id>). Not used today because
   *  extractRepos's network path adds 10s/lead. */
  arxiv_id?: string | null;
}

export interface EnrichmentDelta {
  s2_author_id?: string | null;
  h_index?: number | null;
  citation_count?: number | null;
  paper_count?: number | null;
  person_id?: string | null;
  industry_orgs?: string[] | null;
  industry_source?: string | null;
  /** Extracted from abstract via repo-extractor. pipeline_leads has no
   *  column for these today (they live on `papers`), but we return
   *  them so a future migration can persist without re-running. */
  hf_repo?: string | null;
  github_repo?: string | null;
}

export interface EnrichmentSummary {
  delta: EnrichmentDelta;
  /** Which sub-steps actually wrote something. Empty = nothing
   *  enriched (S2 returned null AND no repos found AND person
   *  resolution declined). */
  populated_fields: string[];
  /** Per-step errors, for logging. Step failure never throws — it
   *  just shows up here so the caller can decide to surface or
   *  suppress. */
  errors: Record<string, string>;
}

/**
 * Best-effort enrichment for a pipeline_leads row at IMPORT time.
 * Bounded: each sub-step has a small timeout. The whole function
 * should return within ~15s even on slow S2.
 *
 * The caller is expected to MERGE the returned `delta` onto the row
 * (or call updateLeadWithDelta() below).
 */
export async function enrichLeadOnImport(
  input: LeadEnrichmentInput,
): Promise<EnrichmentSummary> {
  const delta: EnrichmentDelta = {};
  const errors: Record<string, string> = {};
  const populated: string[] = [];

  const existing = input.existing ?? {};

  // ── Step 1: S2 author lookup ─────────────────────────────────────
  // Skip when caller already has h_index / citation_count — usually
  // means Python's S2 path succeeded.
  const needS2 =
    existing.h_index == null &&
    existing.citation_count == null &&
    existing.s2_author_id == null;
  if (needS2 && input.author_name) {
    try {
      const s2 = await lookupAuthor(input.title, input.author_name);
      if (s2) {
        delta.s2_author_id = s2.authorId;
        delta.h_index = s2.hIndex;
        delta.citation_count = s2.citationCount;
        delta.paper_count = s2.paperCount;
        if (s2.authorId) populated.push("s2_author_id");
        if (s2.hIndex !== null) populated.push("h_index");
        if (s2.citationCount !== null) populated.push("citation_count");
        if (s2.paperCount !== null) populated.push("paper_count");

        // Industry-org detection from S2 affiliations (the most
        // reliable signal — see /api/pipeline/import for the same
        // pattern). Only fills when caller didn't already supply.
        const haveOrgs = (existing.industry_orgs ?? []).length > 0;
        if (!haveOrgs && s2.affiliations.length > 0) {
          const fromS2 = detectOrgs(s2.affiliations.join(" | "));
          if (fromS2.length > 0) {
            delta.industry_orgs = fromS2;
            delta.industry_source = "s2";
            populated.push("industry_orgs");
          }
        }
      }
    } catch (err) {
      errors.s2 = String(err).slice(0, 200);
    }
  }

  // ── Step 2: HF / GitHub repo extraction from abstract ─────────────
  // Cheap (pure regex), no network. The result is informational
  // today — pipeline_leads has no hf_repo/github_repo columns yet —
  // but the delta carries it for future schema additions.
  if (input.abstract) {
    try {
      const repos = extractFromText(input.abstract);
      if (repos.hf_repo) {
        delta.hf_repo = repos.hf_repo;
        populated.push("hf_repo");
      }
      if (repos.github_repo) {
        delta.github_repo = repos.github_repo;
        populated.push("github_repo");
      }
    } catch (err) {
      errors.repo_extract = String(err).slice(0, 200);
    }
  }

  // ── Step 3: Person resolution ─────────────────────────────────────
  // Find-or-create a persons row from (email, arxiv_author_name).
  // Skip when caller already linked one. Failure is non-blocking —
  // mirrors the discovery/promote behavior.
  if (!existing.person_id) {
    try {
      const resolved = await resolvePerson({
        email: input.author_email,
        arxiv_author_name: input.author_name || undefined,
      });
      delta.person_id = resolved.id;
      populated.push("person_id");
    } catch (err) {
      errors.person = String(err).slice(0, 200);
    }
  }

  return { delta, populated_fields: populated, errors };
}

/**
 * Apply an EnrichmentDelta to a pipeline_leads row.
 *
 * Strips null/undefined so we never overwrite existing values with
 * blanks — same posture as h-index-enrich.ts. Returns whether the
 * update touched at least one column.
 *
 * Note: hf_repo / github_repo on the delta are NOT persisted today
 * (no column on pipeline_leads). They're silently dropped.
 */
export async function updateLeadWithDelta(
  leadId: string,
  delta: EnrichmentDelta,
): Promise<{ wrote: boolean; columns: string[] }> {
  const upd: Record<string, unknown> = {};
  // Only forward columns that actually exist on pipeline_leads.
  const persistable = [
    "s2_author_id",
    "h_index",
    "citation_count",
    "paper_count",
    "person_id",
    "industry_orgs",
    "industry_source",
  ] as const;
  for (const key of persistable) {
    const v = (delta as Record<string, unknown>)[key];
    if (v !== null && v !== undefined) {
      // For arrays (industry_orgs), drop empty arrays — they're
      // equivalent to "no signal" and would overwrite a meaningful
      // value set elsewhere.
      if (Array.isArray(v) && v.length === 0) continue;
      upd[key] = v;
    }
  }
  if (Object.keys(upd).length === 0) {
    return { wrote: false, columns: [] };
  }
  const { error } = await supabase
    .from("pipeline_leads")
    .update(upd)
    .eq("id", leadId);
  if (error) {
    console.error(`[lead-enrichment] update lead=${leadId} failed: ${error.message}`);
    return { wrote: false, columns: [] };
  }
  return { wrote: true, columns: Object.keys(upd) };
}

/**
 * Assemble the baseline draft at import time using the org-wide
 * global template. Rep-specific placeholders stay as sentinels so a
 * later allocator + rep template can rewrite them via
 * resolveLatePlaceholders().
 *
 * Returns null when no global template is configured (early-deploy
 * env where migration 011 hasn't been applied) — caller should fall
 * back to whatever Python supplied.
 */
export async function assembleDraftAtImport(input: {
  lead_id: string;
  title: string;
  abstract: string | null;
  author_email: string;
  first_name: string | null;
  school_name: string | null;
  school_tier: number | null;
  matched_directions: string[];
}): Promise<{
  subject: string;
  html: string;
  template_id: string | null;
  intro_prompt_resolved: string | null;
  intro_output: string | null;
} | null> {
  try {
    // rep_id=null → global. leadId enables deterministic A/B split.
    const tpl = await loadEffectiveTemplate(null, input.lead_id);
    if (!tpl) return null;
    const draft = await assembleDraft(tpl, {
      title: input.title,
      abstract: input.abstract ?? "",
      authorEmail: input.author_email,
      firstName: input.first_name,
      schoolName: input.school_name,
      schoolTier: input.school_tier,
      matchedDirections: input.matched_directions,
      // Placeholders kept as literal sentinels in the assembled HTML —
      // resolveLatePlaceholders at send time will swap in the actual
      // rep identity. The repName / repWechatId values passed here are
      // unused for the body (template emits {{REP_NAME}} etc.) but
      // assembleDraft's signature requires strings — pass canonical
      // sentinels so any path that leaks them is visible.
      repName: "{{REP_NAME}}",
      repWechatId: "{{REP_WECHAT}}",
    });
    return {
      subject: draft.subject,
      html: draft.html,
      template_id: tpl.id,
      intro_prompt_resolved: draft.introPromptResolved ?? null,
      intro_output: draft.introOutput ?? null,
    };
  } catch (err) {
    console.error(
      `[lead-enrichment] assembleDraftAtImport lead=${input.lead_id} failed: ${String(err).slice(0, 200)}`,
    );
    // Fall back to legacy generateDraft so callers always get
    // SOMETHING usable. This path returns templateId=null which is
    // fine — the morning allocator will re-render against the rep's
    // effective template anyway.
    try {
      const d = await generateDraft({
        title: input.title,
        abstract: input.abstract ?? "",
        authorEmail: input.author_email,
        firstName: input.first_name,
        schoolName: input.school_name,
        schoolTier: input.school_tier,
        matchedDirections: input.matched_directions,
        repName: "{{REP_NAME}}",
        repWechatId: "{{REP_WECHAT}}",
        assignedRepId: null,
        leadId: input.lead_id,
      });
      return {
        subject: d.subject,
        html: d.html,
        template_id: d.templateId,
        intro_prompt_resolved: d.introPromptResolved ?? null,
        intro_output: d.introOutput ?? null,
      };
    } catch (err2) {
      console.error(
        `[lead-enrichment] generateDraft fallback also failed lead=${input.lead_id}: ${String(err2).slice(0, 200)}`,
      );
      return null;
    }
  }
}

/**
 * Convenience: full enrich + template + persist for a lead that's
 * already been inserted into pipeline_leads. Used by the backfill
 * cron (and could be used post-insert by the import route, but the
 * import route inlines the writes for control over partial updates).
 *
 * Returns a summary suitable for cron logging.
 */
export async function enrichAndTemplateExistingLead(leadId: string): Promise<{
  populated: string[];
  template_id: string | null;
  errors: Record<string, string>;
}> {
  const { data: row, error } = await supabase
    .from("pipeline_leads")
    .select(
      "id, title, abstract, author_name, author_email, first_name, school_name, school_tier, matched_directions, s2_author_id, h_index, citation_count, paper_count, person_id, industry_orgs, status, arxiv_id",
    )
    .eq("id", leadId)
    .maybeSingle();
  if (error || !row) {
    return { populated: [], template_id: null, errors: { fetch: error?.message ?? "no row" } };
  }

  const summary = await enrichLeadOnImport({
    lead_id: row.id as string,
    title: (row.title as string) ?? "",
    abstract: (row.abstract as string) ?? null,
    author_name: (row.author_name as string) ?? null,
    author_email: (row.author_email as string) ?? "",
    first_name: (row.first_name as string) ?? null,
    school_name: (row.school_name as string) ?? null,
    school_tier: (row.school_tier as number) ?? null,
    matched_directions: row.matched_directions as string | string[] | null,
    arxiv_id: (row.arxiv_id as string) ?? null,
    existing: {
      s2_author_id: (row.s2_author_id as string) ?? null,
      h_index: (row.h_index as number) ?? null,
      citation_count: (row.citation_count as number) ?? null,
      paper_count: (row.paper_count as number) ?? null,
      person_id: (row.person_id as string) ?? null,
      industry_orgs: (row.industry_orgs as string[]) ?? null,
    },
  });

  await updateLeadWithDelta(row.id as string, summary.delta);

  // Only re-template leads still in queued/new (don't clobber sent /
  // replied / skipped). Re-templating an already-assigned lead is
  // safe but wasteful — the allocator already did that.
  let templateId: string | null = null;
  const status = row.status as string;
  if (status === "queued" || status === "new") {
    const mdRaw = row.matched_directions;
    const matched_directions =
      typeof mdRaw === "string"
        ? mdRaw.split(",").map((s) => s.trim()).filter(Boolean)
        : Array.isArray(mdRaw) ? (mdRaw as string[]) : [];
    const draft = await assembleDraftAtImport({
      lead_id: row.id as string,
      title: (row.title as string) ?? "",
      abstract: (row.abstract as string) ?? null,
      author_email: (row.author_email as string) ?? "",
      first_name: (row.first_name as string) ?? null,
      school_name: (row.school_name as string) ?? null,
      school_tier: (row.school_tier as number) ?? null,
      matched_directions,
    });
    if (draft) {
      templateId = draft.template_id;
      await supabase
        .from("pipeline_leads")
        .update({
          draft_subject: draft.subject,
          draft_html: draft.html,
          draft_original_subject: draft.subject,
          draft_original_html: draft.html,
          draft_intro_prompt_resolved: draft.intro_prompt_resolved,
          draft_intro_output: draft.intro_output,
          draft_model: "server-import",
        })
        .eq("id", row.id);
    }
  }

  return {
    populated: summary.populated_fields,
    template_id: templateId,
    errors: summary.errors,
  };
}
