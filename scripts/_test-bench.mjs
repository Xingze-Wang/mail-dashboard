import { readFileSync } from "node:fs";
const envFile = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}

const { evaluatePersonaRecipient, evaluateCtrRegressor, evaluateEmailQuality, classifyArchetype, writePrediction } = await import("/Users/xingzewang/Desktop/mail/src/lib/model-bench.ts");
const { createClient } = await import("@supabase/supabase-js");
const sb = createClient("https://erguqrisqtugfysofwdd.supabase.co","eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",{auth:{persistSession:false}});

// Pick one prompt of each kind, evaluate against 2 candidates
const { data: prompts } = await sb.from("model_prompts").select("*").eq("active", true);
console.log("Total prompts:", prompts?.length);

// Test 1 — Email quality judge on a real template
const { data: tmpls } = await sb.from("email_templates").select("*").eq("status", "proposal").limit(2);
const qualityPrompt = prompts.find(p => p.name === "quality_v1_gemini");
console.log("\nTesting quality_v1_gemini on", tmpls?.length, "templates...");
for (const t of tmpls || []) {
  try {
    const t0 = Date.now();
    const rendered = [t.subject_format, t.greeting_format, t.intro_prompt, t.rep_intro_format, t.school_pitch_format, t.cta_signoff_format].filter(Boolean).join("\n\n");
    const r = await evaluateEmailQuality(qualityPrompt, { template_name: t.name, rendered_sample: rendered, segment: t.segment_default });
    console.log("  ", t.name.slice(0, 40), "→", JSON.stringify(r).slice(0, 200), "in", Date.now()-t0, "ms");
    await writePrediction({ prompt: qualityPrompt, email_id: null, template_id: t.id, prediction: r, headline: r.would_approve?1:0, llm_model: qualityPrompt.llm_model, llm_latency_ms: Date.now()-t0 });
  } catch(e) {
    console.log("  FAIL:", String(e).slice(0, 200));
  }
}

// Test 2 — CTR regressor on a real email
const { data: emails } = await sb.from("emails").select("id, subject, html, status, to, thread_id").in("status", ["delivered", "clicked"]).limit(2);
const ctrPrompt = prompts.find(p => p.name === "ctr_v1_gemini");
console.log("\nTesting ctr_v1_gemini on", emails?.length, "emails...");
for (const e of emails || []) {
  try {
    const t0 = Date.now();
    const { data: lead } = await sb.from("pipeline_leads").select("school_tier, h_index, citation_count, school_name, author_email, matched_directions").eq("thread_id", e.thread_id).maybeSingle();
    const archetype = classifyArchetype({ school_tier: lead?.school_tier, h_index: lead?.h_index, citation_count: lead?.citation_count, author_email: e.to, school_name: lead?.school_name });
    const ls = JSON.stringify({ school: lead?.school_name, tier: lead?.school_tier, h: lead?.h_index, archetype });
    const body = (e.html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const r = await evaluateCtrRegressor(ctrPrompt, { lead_summary: ls, email_subject: e.subject, email_body: body });
    console.log("  ", e.id.slice(0, 12), "→", JSON.stringify(r).slice(0, 200), "in", Date.now()-t0, "ms");
    await writePrediction({ prompt: ctrPrompt, email_id: e.id, template_id: null, prediction: r, headline: r.p_click, llm_model: ctrPrompt.llm_model, llm_latency_ms: Date.now()-t0 });
  } catch(err) {
    console.log("  FAIL:", String(err).slice(0, 200));
  }
}

// Test 3 — Persona prompts (one matching archetype)
console.log("\nTesting persona prompts on emails...");
for (const e of emails || []) {
  try {
    const t0 = Date.now();
    const { data: lead } = await sb.from("pipeline_leads").select("school_tier, h_index, citation_count, school_name, author_email, matched_directions").eq("thread_id", e.thread_id).maybeSingle();
    const archetype = classifyArchetype({ school_tier: lead?.school_tier, h_index: lead?.h_index, citation_count: lead?.citation_count, author_email: e.to, school_name: lead?.school_name });
    const personaPrompt = prompts.find(p => p.kind === "persona_recipient" && p.persona_archetype === archetype && p.llm_model === "gemini-2.5-flash");
    if (!personaPrompt) { console.log("  ", archetype, "no prompt"); continue; }
    const ls = JSON.stringify({ school: lead?.school_name, tier: lead?.school_tier, h: lead?.h_index, archetype });
    const body = (e.html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const r = await evaluatePersonaRecipient(personaPrompt, { archetype, email_subject: e.subject, email_body: body, lead_summary: ls });
    console.log("  ", archetype, e.id.slice(0, 12), "→", JSON.stringify(r).slice(0, 200), "in", Date.now()-t0, "ms");
    await writePrediction({ prompt: personaPrompt, email_id: e.id, template_id: null, prediction: r, headline: r.p_click, llm_model: personaPrompt.llm_model, llm_latency_ms: Date.now()-t0 });
  } catch(err) {
    console.log("  FAIL:", String(err).slice(0, 200));
  }
}
console.log("\nDONE");
