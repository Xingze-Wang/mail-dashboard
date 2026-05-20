import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { wasRecentlyContacted, paperWasRecentlyContacted } from "@/lib/contact-guard";
import { checkBlocked } from "@/lib/blocklist";
import { canonicalizeEmail } from "@/lib/email-id";
import { canonicalizeArxivId } from "@/lib/arxiv-id";
import { fillRepPlaceholders } from "@/lib/rep-template";
import { scoreWithGemini } from "@/lib/gemini-scorer";
import { lookupAuthor } from "@/lib/semantic-scholar";
import { detectOrgs } from "@/lib/industry-orgs";
import { mineAckIndustry } from "@/lib/ack-mining";
import {
  getAssignmentConfig,
  classifyLead,
  getRep,
} from "@/lib/assignment";
import { requireSession } from "@/lib/auth-helpers";
import {
  enrichLeadOnImport,
  updateLeadWithDelta,
  assembleDraftAtImport,
} from "@/lib/lead-enrichment";
import { enrichPerson } from "@/lib/person-enrichment";

/**
 * POST /api/pipeline/import
 *
 * Universal lead import endpoint. Accepts leads from any source
 * (Python scripts, manual entry, external tools).
 *
 * Body: single lead or array of leads
 * {
 *   "leads": [{
 *     "title": "Company Name or Paper Title",
 *     "authorEmail": "founder@startup.com",        // required
 *     "authorName": "John Doe",
 *     "source": "github",                          // github, jike, manual, etc.
 *     "draftSubject": "Subject line",
 *     "draftHtml": "<p>Email body</p>",
 *     "abstract": "Description or context",
 *     "schoolName": "MIT",
 *     "computeLevel": "heavy",
 *     "computeConfidence": 0.8,
 *     "computeReason": "Why this lead matters",
 *     "matchedDirections": "ai,robotics",
 *     "arxivId": "2604.12345",                     // optional, for arxiv leads
 *     "pdfUrl": "https://...",
 *     "publishedAt": "2026-04-05T00:00:00Z",
 *   }]
 * }
 *
 * Or shorthand for single lead (no "leads" wrapper):
 * { "title": "...", "authorEmail": "...", ... }
 *
 * Auth: API key via Authorization header, or internal referer.
 * Set PIPELINE_IMPORT_KEY env var to require auth.
 */
export async function POST(req: NextRequest) {
  // Auth: EITHER a valid user session OR a bearer token matching
  // PIPELINE_IMPORT_KEY (for external scrapers). The prior "referer
  // includes host" check was trivially spoofable — any authenticated
  // browser tab or any attacker crafting a Referer header passed it.
  const importKey = process.env.PIPELINE_IMPORT_KEY;
  const auth = req.headers.get("authorization") || "";
  const hasValidKey = !!importKey && auth === `Bearer ${importKey}`;
  if (!hasValidKey) {
    const session = await requireSession(req);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const body = await req.json();

    // Accept single lead or array
    const leads: Record<string, unknown>[] = body.leads
      ? body.leads
      : [body];

    let imported = 0;
    let skipped = 0;
    let duplicateInPipeline = 0;
    let blockedByAppropriateness = 0;
    const errors: string[] = [];
    const blockedByGuard: { email: string; lastContactedAt: string }[] = [];
    const blockedByEthics: { email: string; title: string; category: string; reason: string }[] = [];

    // Load assignment config once for the whole batch
    const config = await getAssignmentConfig();

    // Garbage-name set: Python scrapers occasionally stringify None /
    // null / undefined when a field is missing, producing literal
    // strings here. Per user 'if there is null or anything like that
    // just kill the lead' — we reject at import. Better not to have
    // it than to have it.
    const GARBAGE_NAMES = new Set([
      "null", "Null", "NULL",
      "undefined", "Undefined", "UNDEFINED",
      "none", "None", "NONE",
      "nan", "NaN", "NAN",
      "n/a", "N/A", "na",
      "",
    ]);

    for (const lead of leads) {
      const rawEmail = lead.authorEmail as string;
      if (!rawEmail || typeof rawEmail !== "string" || !rawEmail.includes("@")) {
        errors.push("Missing or invalid authorEmail");
        skipped++;
        continue;
      }

      // Garbage-firstName guard. Treat the lead as malformed and skip.
      const firstNameRaw = (lead.firstName as string | null | undefined) ?? null;
      if (firstNameRaw !== null && typeof firstNameRaw === "string") {
        if (GARBAGE_NAMES.has(firstNameRaw.trim())) {
          errors.push(`Skipped: garbage firstName "${firstNameRaw}" for ${rawEmail}`);
          skipped++;
          continue;
        }
      }
      // Aggressively canonicalize so dedup catches:
      //   - mixed case
      //   - "+tag" subaddresses (john+work@x.com → john@x.com)
      //   - Gmail dots and googlemail.com aliases
      const email = canonicalizeEmail(rawEmail);

      // Hard blocklist — domain or email blacklisted by senior/admin.
      // Stops bad leads from ever reaching the pipeline.
      const blockHit = await checkBlocked(email);
      if (blockHit) {
        blockedByGuard.push({ email: `[blocked] ${email}`, lastContactedAt: blockHit.blocked_at });
        skipped++;
        continue;
      }

      // Person firewall — has anyone contacted THIS RECIPIENT in 365 days?
      // Three tables (emails / email_contact_history / persons) — see
      // src/lib/contact-guard.ts.
      const contact = await wasRecentlyContacted(email);
      if (contact.contacted) {
        blockedByGuard.push({ email, lastContactedAt: contact.lastAt! });
        skipped++;
        continue;
      }

      // Paper firewall — has ANY co-author of this paper been contacted in
      // 365 days? Prevents the "different author, same paper" loophole that
      // pipeline_leads dedup misses if the row was deleted/skipped.
      // Try arxivId first; if absent, derive from pdfUrl. Both go through
      // canonicalize so format variants collapse to the same string.
      const incomingArxivIdRaw =
        (lead.arxivId as string) || (lead.pdfUrl as string) || null;
      const arxivIdCanonical = canonicalizeArxivId(incomingArxivIdRaw);
      if (arxivIdCanonical && arxivIdCanonical.match(/^\d{4}\.\d{4,5}/)) {
        const paperHit = await paperWasRecentlyContacted(arxivIdCanonical);
        if (paperHit.contacted) {
          blockedByGuard.push({
            email: `[paper ${arxivIdCanonical}] ${email}`,
            lastContactedAt: paperHit.lastAt!,
          });
          skipped++;
          continue;
        }
      }

      // Dedup against rows already in pipeline_leads:
      //   (a) same email — different paper but same person
      //   (b) same arxiv_id — same paper, different co-author
      const orFilter = arxivIdCanonical
        ? `author_email.ilike.${email},arxiv_id.eq.${arxivIdCanonical}`
        : `author_email.ilike.${email}`;
      const { data: existing } = await supabase
        .from("pipeline_leads")
        .select("id, status, author_email, arxiv_id")
        .or(orFilter)
        .not("status", "in", "(skipped,bounced)")
        .limit(1);
      if (existing && existing.length > 0) {
        duplicateInPipeline++;
        skipped++;
        continue;
      }

      const title = (lead.title as string) || "(untitled)";
      const source = (lead.source as string) || "external";
      const authorName = (lead.authorName as string) || null;
      const schoolTier = (lead.schoolTier as number) || null;

      // `authors` is the full co-author list from arxiv. Python sends it as
      // a comma-joined string; some callers may pass an array. Either way,
      // normalize to a string for the `authors` column. Falls back to
      // authorName (single recipient) when caller doesn't send it.
      const incomingAuthors = lead.authors;
      let authorsField: string | null = authorName;
      if (typeof incomingAuthors === "string" && incomingAuthors.trim()) {
        authorsField = incomingAuthors.trim();
      } else if (Array.isArray(incomingAuthors) && incomingAuthors.length > 0) {
        authorsField = incomingAuthors
          .filter((a) => typeof a === "string" && a.trim())
          .join(", ") || authorName;
      }

      // Classification uses what Python sent us. If Python missed citation
      // data (most leads — Python's S2 path is flaky), fall back to a quick
      // server-side S2 lookup. Adds ~3-5s to imports that need it but means
      // the dashboard actually has citation/h-index data to score on.
      let pyCitation = typeof lead.citationCount === "number" ? lead.citationCount : null;
      let pyHIndex = typeof lead.hIndex === "number" ? lead.hIndex : null;
      let pyS2AuthorId = (lead.s2AuthorId as string | null) ?? null;
      let pyPaperCount = typeof lead.paperCount === "number" ? lead.paperCount : null;
      const pyLocalScore = typeof lead.localScore === "number" ? lead.localScore : null;
      let industryOrgs: string[] = [];
      let industrySource: string | null = null;
      if (pyCitation === null && authorName) {
        try {
          const s2 = await lookupAuthor(title, authorName);
          if (s2) {
            pyCitation = s2.citationCount;
            pyHIndex = s2.hIndex;
            pyS2AuthorId = s2.authorId;
            pyPaperCount = s2.paperCount;
            // Detect industry orgs from S2 affiliations (most reliable signal)
            const fromS2 = detectOrgs(s2.affiliations.join(" | "));
            if (fromS2.length > 0) {
              industryOrgs = fromS2;
              industrySource = "s2";
            }
          }
        } catch {
          // S2 timeout / rate limit — leave nulls, backfill route picks up later.
        }
      }
      // Ack mining: only if we don't already have an industry signal from S2.
      // Best-effort, won't block import on failure.
      if (industryOrgs.length === 0 && arxivIdCanonical) {
        try {
          const ack = await mineAckIndustry(arxivIdCanonical);
          if (ack.orgs.length > 0) {
            industryOrgs = ack.orgs;
            industrySource = ack.source;
          }
        } catch {
          // best-effort
        }
      }
      const leadTier = classifyLead(config, {
        citationCount: pyCitation,
        hIndex: pyHIndex,
        schoolTier,
        authorEmail: email,
        localScore: pyLocalScore,
        industryOrgs,
      });
      // Per docs/superpowers/specs/2026-05-13-shared-pool-and-mission-ux-design.md,
      // assignment is deferred to /api/missions/allocate-leads (runs daily at
      // 09:00 Beijing). Imports land in the pool with assigned_rep_id=NULL;
      // the allocator picks them up next morning based on each rep's daily
      // quota. lead_tier is still classified so the v_lead_pool view can
      // partition by sub-pool.
      const assignedRepId: number | null = null;

      // ── APPROPRIATENESS GATE (paper-level ethics filter) ───────────
      // Per 2026-05-19 meta-audit finding: judges score offensive-security
      // papers (backdoors, jailbreaks, attacks on LLaMA/DeepSeek/GPT) as
      // "faithful" because the intro is, but offering free GPUs to scale
      // an attack is a reputational landmine. We screen the paper itself.
      // useJudge=true: runs the LLM judge for ambiguous cases (only fires
      // when deterministic signals are present, so most leads skip it).
      {
        const { screenPaperAppropriateness } = await import("@/lib/email-appropriateness");
        const appr = await screenPaperAppropriateness({
          title,
          abstract: (lead.abstract as string) || "",
          authorEmail: email,
          useJudge: true,
        });
        if (!appr.ok) {
          blockedByAppropriateness++;
          skipped++;
          blockedByEthics.push({
            email: email || "(no email)",
            title: title.slice(0, 80),
            category: appr.category || "unknown",
            reason: appr.hard.map((h) => h.message).join("; ").slice(0, 200),
          });
          continue;
        }
      }

      // Prefer the canonicalized arxiv id; synthesize a unique one otherwise.
      const arxivId = arxivIdCanonical ||
        `${source}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

      // If Python supplied a draft (body + subject, typically with
      // {{REP_NAME}} / {{REP_WECHAT}} placeholders), keep the placeholders
      // intact — the rep isn't known yet. The draft-queue worker will
      // re-render with rep identity after the allocator assigns the lead.
      // Scoring still runs at import time so the lead has a relevance signal.
      const incomingSubject = (lead.draftSubject as string) || null;
      const incomingHtml = (lead.draftHtml as string) || null;
      const incomingScore = typeof lead.localScore === "number" ? lead.localScore : null;
      const abstractStr = (lead.abstract as string) || "";

      const scoreLookup =
        incomingScore !== null ? incomingScore : await scoreWithGemini(title, abstractStr);

      // ── PAPER-TYPE CLASSIFICATION (mig 105 — log only, not a gate) ───
      // Per 2026-05-20 product call: log what kind of paper this is
      // (empirical_method / benchmark / theory / survey / null_result /
      // measurement / position / unknown). NOT used to filter the lead.
      // Used later to pivot conversion-rate by paper type.
      // Best-effort: failure → "unknown", does NOT block the lead.
      let paperTypeResult: { type: string; reason: string } = { type: "unknown", reason: "not classified" };
      try {
        const { classifyPaperType } = await import("@/lib/paper-type-classifier");
        paperTypeResult = await classifyPaperType({
          title,
          abstract: abstractStr,
        });
      } catch (err) {
        console.warn("paper-type classify failed", { title: title.slice(0, 60), err: String(err).slice(0, 100) });
      }

      // Drafts carry literal {{REP_NAME}} / {{REP_WECHAT}} placeholders until
      // allocation. The draft-queue worker rewrites them post-assignment.
      // `_` suppresses the unused-import lint for fillRepPlaceholders.
      void fillRepPlaceholders;
      // `_` suppresses the unused-import lint for getRep (still used by other
      // callers in this file via Promise.all paths if added later).
      void getRep;
      const finalSubject: string | null = incomingSubject;
      const finalHtml: string | null = incomingHtml;
      // 'queued' (not 'ready') — without a rep, the draft has placeholders,
      // not a sendable email. Allocator + draft-queue flips to 'ready' after
      // re-rendering with the assigned rep's identity.
      const finalStatus: "queued" = "queued";
      const finalScore = scoreLookup ?? null;

      // Draft is generated server-side by /api/pipeline/draft-queue using the
      // assigned rep's identity — we do NOT trust incoming drafts from the
      // Python scraper (which signs everything as Leo). Any draft supplied
      // is discarded in favor of the queue-generated one.

      const { data: insertedRow, error } = await supabase
        .from("pipeline_leads")
        .insert({
          arxiv_id: arxivId,
          title,
          abstract: (lead.abstract as string) || null,
          authors: authorsField,
          pdf_url: (lead.pdfUrl as string) || null,
          published_at: (lead.publishedAt as string) || null,
          author_name: authorName,
          author_email: email,
          first_name: (lead.firstName as string) || null,
          school_name: (lead.schoolName as string) || null,
          school_tier: schoolTier,
          compute_level: (lead.computeLevel as string) || null,
          compute_confidence: (lead.computeConfidence as number) || null,
          compute_reason: (lead.computeReason as string) || null,
          matched_directions: (lead.matchedDirections as string) || null,
          draft_subject: finalSubject,
          draft_html: finalHtml,
          // mig 105 — log paper type for future conversion analytics
          paper_type: paperTypeResult.type,
          paper_type_reason: paperTypeResult.reason,
          // Snapshot of the AI's original output so sales-edit diffs can be
          // mined. Identical to draft_* at insert time, but draft_* will be
          // overwritten by sales editing while these stay frozen.
          draft_original_subject: finalSubject,
          draft_original_html: finalHtml,
          draft_model: (lead.draftModel as string) || "python",
          status: finalStatus,
          local_score: finalScore,
          source,
          s2_author_id: pyS2AuthorId,
          h_index: pyHIndex,
          citation_count: pyCitation,
          paper_count: pyPaperCount,
          lead_tier: leadTier,
          assigned_rep_id: assignedRepId,
          // industry_orgs may be a no-op insert if the column doesn't exist
          // (older DB) — Supabase will silently ignore unknown keys.
          industry_orgs: industryOrgs.length > 0 ? industryOrgs : null,
          industry_source: industrySource,
        })
        .select("id")
        .single();

      if (error) {
        if (error.message.includes("duplicate")) {
          skipped++;
        } else {
          errors.push(`${email}: ${error.message}`);
          skipped++;
        }
      } else {
        imported++;
        const leadId = insertedRow?.id as string | undefined;

        // ── Post-insert enrichment + import-time templating ────────
        // Per user ask: "for every single lead there needs to be
        // enrichment + templating + assignment. assignment happens
        // after but the first two happens kind of first."
        //
        // Bounded ~15s — each sub-step has its own timeout in the
        // helper. Best-effort: a failure here does NOT roll back the
        // insert. The enrich-backfill cron picks up stragglers.
        if (leadId) {
          try {
            const mdRaw = lead.matchedDirections;
            const matchedDirsArr =
              typeof mdRaw === "string"
                ? (mdRaw as string).split(",").map((s) => s.trim()).filter(Boolean)
                : Array.isArray(mdRaw)
                ? (mdRaw as string[]).filter((s) => typeof s === "string")
                : [];

            const summary = await enrichLeadOnImport({
              lead_id: leadId,
              title,
              abstract: (lead.abstract as string) || null,
              author_name: authorName,
              author_email: email,
              first_name: (lead.firstName as string) || null,
              school_name: (lead.schoolName as string) || null,
              school_tier: schoolTier,
              matched_directions: matchedDirsArr,
              arxiv_id: arxivIdCanonical,
              existing: {
                // We already wrote whatever Python (or the inline S2
                // call above) produced. Tell the enricher so it
                // skips work it doesn't need to redo.
                s2_author_id: pyS2AuthorId,
                h_index: pyHIndex,
                citation_count: pyCitation,
                paper_count: pyPaperCount,
                industry_orgs: industryOrgs.length > 0 ? industryOrgs : null,
              },
            });
            await updateLeadWithDelta(leadId, summary.delta);

            // Person-side enrichment: now that the lead has a
            // person_id (just written by updateLeadWithDelta OR set
            // pre-existing), populate {homepage, twitter, hf, github}
            // signals for that person. Best-effort, bounded ~15s, can
            // safely fail without rolling back the import.
            //
            // First check the freshly-written delta. If person_id was
            // already set on the row before this call, the delta won't
            // contain it — do a cheap re-read in that case so we still
            // enrich. New imports always go through the delta path.
            let enrichablePersonId =
              (summary.delta as Record<string, unknown>).person_id as string | null | undefined;
            if (!enrichablePersonId) {
              const { data: pIdRow } = await supabase
                .from("pipeline_leads")
                .select("person_id")
                .eq("id", leadId)
                .maybeSingle();
              enrichablePersonId = (pIdRow?.person_id as string | null | undefined) ?? null;
            }
            if (enrichablePersonId) {
              try {
                await Promise.race([
                  enrichPerson({
                    person_id: enrichablePersonId,
                    hint: {
                      title,
                      abstract: (lead.abstract as string) || undefined,
                      author_name: authorName || undefined,
                    },
                  }),
                  new Promise((_, rej) => setTimeout(() => rej(new Error("person-enrich timeout")), 15_000)),
                ]);
              } catch (pe) {
                console.error(
                  `[import] enrichPerson failed for lead=${leadId} person=${enrichablePersonId}: ${String(pe).slice(0, 200)}`,
                );
              }
            }

            // Baseline draft using the org-wide global template.
            // Rep-specific placeholders ({{REP_NAME}} etc.) stay as
            // sentinels — the allocator + send-time path swap them in.
            const draft = await assembleDraftAtImport({
              lead_id: leadId,
              title,
              abstract: (lead.abstract as string) || null,
              author_email: email,
              first_name: (lead.firstName as string) || null,
              school_name: (lead.schoolName as string) || null,
              school_tier: schoolTier,
              matched_directions: matchedDirsArr,
            });
            if (draft) {
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
                .eq("id", leadId);
            }
          } catch (enrichErr) {
            // Enrichment failure must NOT roll back the import.
            // Logged for triage; backfill cron will pick it up.
            console.error(
              `[import] enrichment failed for lead=${leadId}: ${String(enrichErr).slice(0, 200)}`,
            );
          }
        }
      }
    }

    return NextResponse.json({
      imported,
      skipped,
      duplicateInPipeline,
      errors,
      blockedByGuard,
      blockedByAppropriateness,
      blockedByEthics,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Import failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
