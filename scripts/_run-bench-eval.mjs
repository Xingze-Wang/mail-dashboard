// Run model-bench-eval logic locally so the leaderboard has data
// before the cron's first scheduled run.
import { readFileSync } from "node:fs";
const envFile = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}

const { classifyArchetype, evaluateCtrRegressor, evaluateEmailQuality, evaluatePersonaRecipient, writePrediction } =
  await import("/Users/xingzewang/Desktop/mail/src/lib/model-bench.ts");
const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const sinceISO = new Date(Date.now() - 30 * 86_400_000).toISOString();

const { data: prompts } = await sb.from("model_prompts").select("*").eq("active", true);
console.log("Active prompts:", prompts?.length);

const { data: emails } = await sb.from("emails")
  .select("id, subject, html, status, to, thread_id, paper_arxiv_id")
  .gte("created_at", sinceISO)
  .in("status", ["delivered", "clicked", "bounced", "complained"])
  .limit(40);                       // small first batch — full eval will be cron's job
console.log("Email candidates:", emails?.length);

const { data: tmpls } = await sb.from("email_templates")
  .select("id, name, subject_format, intro_prompt, greeting_format, rep_intro_format, school_pitch_format, cta_signoff_format, segment_default, status, created_at")
  .gte("created_at", sinceISO)
  .limit(20);
console.log("Template candidates:", tmpls?.length);

function stripHtml(html) {
  return (html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ").trim();
}

let ok = 0, failed = 0, skipped = 0;
const tStart = Date.now();

for (const p of prompts || []) {
  console.log("\n→ prompt:", p.kind, p.name, "[", p.llm_model, "]");

  if (p.kind === "persona_recipient" || p.kind === "ctr_regressor") {
    for (const e of emails || []) {
      const { data: lead } = await sb.from("pipeline_leads")
        .select("school_tier, h_index, citation_count, school_name, author_email, matched_directions, lead_tier, click_count")
        .eq("thread_id", e.thread_id).maybeSingle();
      const archetype = classifyArchetype({
        school_tier: lead?.school_tier ?? null, h_index: lead?.h_index ?? null,
        citation_count: lead?.citation_count ?? null, author_email: e.to ?? lead?.author_email ?? null,
        school_name: lead?.school_name ?? null,
      });
      if (p.kind === "persona_recipient" && p.persona_archetype && p.persona_archetype !== archetype) { skipped++; continue; }
      const { data: prior } = await sb.from("model_predictions").select("id").eq("prompt_id", p.id).eq("email_id", e.id).maybeSingle();
      if (prior) { skipped++; continue; }

      const leadSummary = JSON.stringify({ school: lead?.school_name, tier: lead?.school_tier, h: lead?.h_index, citations: lead?.citation_count, dirs: lead?.matched_directions, archetype });
      const t0 = Date.now();
      try {
        if (p.kind === "persona_recipient") {
          const r = await evaluatePersonaRecipient(p, { archetype, email_subject: e.subject || "", email_body: stripHtml(e.html), lead_summary: leadSummary });
          await writePrediction({ prompt: p, email_id: e.id, template_id: null, prediction: r, headline: r.p_click, llm_model: p.llm_model, llm_latency_ms: Date.now() - t0 });
        } else {
          const r = await evaluateCtrRegressor(p, { lead_summary: leadSummary, email_subject: e.subject || "", email_body: stripHtml(e.html) });
          await writePrediction({ prompt: p, email_id: e.id, template_id: null, prediction: r, headline: r.p_click, llm_model: p.llm_model, llm_latency_ms: Date.now() - t0 });
        }
        ok++;
      } catch (err) {
        console.log("  fail:", e.id.slice(0, 12), String(err).slice(0, 100));
        failed++;
      }
    }
  } else if (p.kind === "email_quality_judge") {
    for (const t of tmpls || []) {
      const { data: prior } = await sb.from("model_predictions").select("id").eq("prompt_id", p.id).eq("template_id", t.id).maybeSingle();
      if (prior) { skipped++; continue; }
      const rendered = [t.subject_format, t.greeting_format, t.intro_prompt, t.rep_intro_format, t.school_pitch_format, t.cta_signoff_format].filter(Boolean).join("\n\n");
      const t0 = Date.now();
      try {
        const r = await evaluateEmailQuality(p, { template_name: t.name, rendered_sample: rendered, segment: t.segment_default });
        await writePrediction({ prompt: p, email_id: null, template_id: t.id, prediction: r, headline: r.would_approve ? 1 : 0, llm_model: p.llm_model, llm_latency_ms: Date.now() - t0 });
        ok++;
      } catch (err) {
        console.log("  fail tmpl", t.id.slice(0, 12), String(err).slice(0, 100));
        failed++;
      }
    }
  }
}
console.log("\nDONE — ok:", ok, "failed:", failed, "skipped:", skipped, "in", ((Date.now() - tStart) / 1000).toFixed(1), "s");
