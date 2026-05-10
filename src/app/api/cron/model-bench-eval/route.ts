import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import {
  classifyArchetype,
  evaluateCtrRegressor,
  evaluateEmailQuality,
  evaluatePersonaRecipient,
  writePrediction,
  type PromptRow,
} from "@/lib/model-bench";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * GET /api/cron/model-bench-eval
 *
 * Daily 08:00 UTC (set in vercel.json). Runs each ACTIVE prompt in
 * model_prompts against held-out targets it hasn't predicted yet.
 *
 * Held-out window: last 30 days. New prompts get backfilled against
 * the same 30-day window so they can be ranked next to incumbents.
 *
 * Idempotent: model_predictions has a unique (prompt_id, target_id)
 * index, so re-running on the same day is a no-op.
 *
 * Auth: Bearer $CRON_SECRET.
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const t0 = Date.now();
  const sinceISO = new Date(Date.now() - 30 * 86_400_000).toISOString();

  const { data: prompts } = await supabase
    .from("model_prompts")
    .select("id, kind, name, persona_archetype, system_prompt, llm_model")
    .eq("active", true);

  if (!prompts || prompts.length === 0) {
    return NextResponse.json({ ok: true, ms: Date.now() - t0, note: "no active prompts" });
  }

  // Pull recent emails + templates as the candidate set.
  const [{ data: emails }, { data: tmpls }] = await Promise.all([
    supabase
      .from("emails")
      .select("id, subject, html, status, to, thread_id, paper_arxiv_id")
      .gte("created_at", sinceISO)
      .in("status", ["delivered", "clicked", "bounced", "complained"])
      .limit(400),
    supabase
      .from("email_templates")
      .select("id, name, subject_format, intro_prompt, greeting_format, rep_intro_format, school_pitch_format, cta_signoff_format, segment_default, status, created_at")
      .gte("created_at", sinceISO)
      .limit(80),
  ]);

  const stats = { evaluated: 0, skipped: 0, failed: 0, byPrompt: {} as Record<string, { ok: number; failed: number }> };

  for (const p of prompts as PromptRow[]) {
    stats.byPrompt[p.id] = { ok: 0, failed: 0 };

    if (p.kind === "persona_recipient" || p.kind === "ctr_regressor") {
      const candidates = emails ?? [];
      for (const e of candidates) {
        // Resolve lead context. Prefer paper_arxiv_id → pipeline_leads
        // join; if no lead, fall back to thread_id.
        const { data: lead } = await supabase
          .from("pipeline_leads")
          .select("id, school_tier, h_index, citation_count, school_name, author_email, matched_directions, lead_tier, click_count")
          .eq("thread_id", e.thread_id)
          .maybeSingle();

        const archetype = classifyArchetype({
          school_tier: lead?.school_tier ?? null,
          h_index: lead?.h_index ?? null,
          citation_count: lead?.citation_count ?? null,
          author_email: (e.to as string) ?? lead?.author_email ?? null,
          school_name: lead?.school_name ?? null,
        });

        // Persona prompts are filtered by their archetype — only
        // evaluate "junior_phd_tier1" prompt against junior PhDs etc.
        if (p.kind === "persona_recipient" && p.persona_archetype && p.persona_archetype !== archetype) {
          stats.skipped++;
          continue;
        }

        // Skip if already predicted
        const { data: prior } = await supabase
          .from("model_predictions")
          .select("id")
          .eq("prompt_id", p.id)
          .eq("email_id", e.id)
          .maybeSingle();
        if (prior) { stats.skipped++; continue; }

        const leadSummary = JSON.stringify({
          school: lead?.school_name,
          tier: lead?.school_tier,
          h_index: lead?.h_index,
          citations: lead?.citation_count,
          directions: lead?.matched_directions,
          archetype,
        });

        const tStart = Date.now();
        try {
          if (p.kind === "persona_recipient") {
            const r = await evaluatePersonaRecipient(p, {
              archetype,
              email_subject: e.subject ?? "",
              email_body: stripHtml(e.html as string ?? ""),
              lead_summary: leadSummary,
            });
            await writePrediction({
              prompt: p,
              email_id: e.id,
              template_id: null,
              prediction: r,
              headline: r.p_click,
              llm_model: p.llm_model,
              llm_latency_ms: Date.now() - tStart,
            });
          } else {
            const r = await evaluateCtrRegressor(p, {
              lead_summary: leadSummary,
              email_subject: e.subject ?? "",
              email_body: stripHtml(e.html as string ?? ""),
            });
            await writePrediction({
              prompt: p,
              email_id: e.id,
              template_id: null,
              prediction: r,
              headline: r.p_click,
              llm_model: p.llm_model,
              llm_latency_ms: Date.now() - tStart,
            });
          }
          stats.byPrompt[p.id].ok++;
          stats.evaluated++;
        } catch (err) {
          console.error("[model-bench]", p.kind, p.name, "fail:", err);
          stats.byPrompt[p.id].failed++;
          stats.failed++;
        }
      }
    } else if (p.kind === "email_quality_judge") {
      const candidates = tmpls ?? [];
      for (const t of candidates) {
        const { data: prior } = await supabase
          .from("model_predictions")
          .select("id")
          .eq("prompt_id", p.id)
          .eq("template_id", t.id)
          .maybeSingle();
        if (prior) { stats.skipped++; continue; }

        // Render a representative sample by joining the template's
        // slots into one prose block. Cheap and deterministic.
        const rendered = [t.subject_format, t.greeting_format, t.intro_prompt, t.rep_intro_format, t.school_pitch_format, t.cta_signoff_format]
          .filter(Boolean).join("\n\n");

        const tStart = Date.now();
        try {
          const r = await evaluateEmailQuality(p, {
            template_name: t.name as string,
            rendered_sample: rendered,
            segment: (t.segment_default as string | null) ?? null,
          });
          await writePrediction({
            prompt: p,
            email_id: null,
            template_id: t.id,
            prediction: r,
            headline: r.would_approve ? 1 : 0,
            llm_model: p.llm_model,
            llm_latency_ms: Date.now() - tStart,
          });
          stats.byPrompt[p.id].ok++;
          stats.evaluated++;
        } catch (err) {
          console.error("[model-bench] email_quality_judge", p.name, "fail:", err);
          stats.byPrompt[p.id].failed++;
          stats.failed++;
        }
      }
    }
  }

  return NextResponse.json({
    ok: true,
    ms: Date.now() - t0,
    prompts: prompts.length,
    candidates: { emails: emails?.length ?? 0, templates: tmpls?.length ?? 0 },
    stats,
  });
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
