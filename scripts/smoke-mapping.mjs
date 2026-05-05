// End-to-end smoke for the mapping module.
//   1. Create a target (lifesci postdocs)
//   2. Find candidate leads matching the spec
//   3. Draft for the first lead
//   4. Approve the draft → should write to pipeline_leads.draft_html
//   5. Run the evolution loop — should propose ONE revision
//
// Cleans up: deletes the test target + drafts + lead status reverts.

import { createClient } from "@supabase/supabase-js";
import "dotenv/config";
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

const PROXY_URL = "https://openai-proxy.miracleplus.com/v1/chat/completions";
const PROXY_KEY = process.env.MIRACLEPLUS_PROXY_KEY;
const DRAFT_MODEL = "claude-sonnet-4-6";

async function llm(system, user, opts = {}) {
  const body = {
    model: DRAFT_MODEL,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    temperature: opts.temperature ?? 0.4,
    max_tokens: opts.max_tokens ?? 1500,
  };
  if (opts.json) body.response_format = { type: "json_object" };
  const r = await fetch(PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${PROXY_KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 100)}`);
  const j = await r.json();
  return j.choices?.[0]?.message?.content ?? "";
}

const REP_ID = 5; // Xingze (admin)
let passed = 0, failed = 0;
const cleanup = [];
const pass = (l, info) => { passed++; console.log(`✓ ${l}${info ? "  " + info : ""}`); };
const fail = (l, e) => { failed++; console.error(`✗ ${l}: ${e}`); };

// 1. Create target
let targetId = null;
try {
  const { data, error } = await sb.from("mapping_targets").insert({
    owner_rep_id: REP_ID,
    label: "[smoke] lifesci postdocs",
    spec: { vertical: "lifesci", topic_keywords: ["protein", "drug discovery", "molecular"], school_tier: 1, geo: "any" },
    guidelines: "Don't promise specific GPU counts. Don't quote prices.",
  }).select("id").single();
  if (error) throw error;
  targetId = data.id;
  cleanup.push({ fn: () => sb.from("mapping_targets").delete().eq("id", targetId), label: "delete target" });
  pass("createTarget", `→ ${targetId}`);
} catch (e) { fail("createTarget", e.message); }

// 2. Find candidates (uses the same SQL filter as findCandidateLeads)
let candidateLead = null;
try {
  const { data: target } = await sb.from("mapping_targets").select("spec").eq("id", targetId).maybeSingle();
  const spec = target.spec;
  let q = sb.from("pipeline_leads").select("id, title, author_name, author_email, citation_count, matched_directions, school_tier").eq("status", "ready").limit(30);
  if (spec.school_tier) q = q.eq("school_tier", spec.school_tier);
  const { data: leads } = await q;
  if (!leads?.length) {
    pass("findCandidateLeads", "→ no ready leads matching tier 1 — using any ready lead for smoke");
    const { data: any } = await sb.from("pipeline_leads").select("id, title, author_name, author_email").eq("status", "ready").limit(1);
    candidateLead = any?.[0] ?? null;
  } else {
    candidateLead = leads[0];
    pass("findCandidateLeads", `→ ${leads.length} candidates, picked "${candidateLead.title?.slice(0, 50)}"`);
  }
  if (!candidateLead) throw new Error("no leads to draft against");
} catch (e) { fail("findCandidateLeads", e.message); }

// 3. Draft for one lead
let draftId = null;
try {
  const { data: target } = await sb.from("mapping_targets").select("*").eq("id", targetId).maybeSingle();
  const userPrompt = `## Target\nLabel: ${target.label}\nSpec: ${JSON.stringify(target.spec)}\n${target.guidelines ? `Guidelines:\n${target.guidelines}\n` : ""}\n\n## Lead\nName: ${candidateLead.author_name}\nEmail: ${candidateLead.author_email}\nTitle: ${candidateLead.title}\n\n## No template yet — write a tight personalized intro\n\nStrict JSON:\n{ "subject": "...", "body_html": "...", "match_reason": "..." }`;
  const raw = await llm(
    "你是 sales 助手, 给奇绩算力潜在客户写邮件. 不撒谎, 不 over-commit, 不报价格. 100-200 字.",
    userPrompt,
    { json: true, max_tokens: 1500, temperature: 0.4 },
  );
  const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""));
  if (!parsed.subject || !parsed.body_html) throw new Error("malformed draft");

  const { data, error } = await sb.from("mapping_drafts").insert({
    target_id: targetId,
    lead_id: candidateLead.id,
    subject: parsed.subject,
    body_html: parsed.body_html,
    match_reason: parsed.match_reason ?? "(no reason)",
    state: "pending",
  }).select("id").single();
  if (error) throw error;
  draftId = data.id;
  cleanup.push({ fn: () => sb.from("mapping_drafts").delete().eq("id", draftId), label: "delete draft" });
  pass("draftForLead",
    `→ subject="${parsed.subject.slice(0, 40)}", body=${parsed.body_html.length}ch`);
} catch (e) { fail("draftForLead", e.message); }

// 4. Approve the draft (simulated decideDraft)
try {
  // Capture original draft_html to restore later
  const { data: leadBefore } = await sb.from("pipeline_leads").select("draft_html, draft_subject").eq("id", candidateLead.id).maybeSingle();
  const origHtml = leadBefore?.draft_html ?? null;
  const origSubject = leadBefore?.draft_subject ?? null;
  cleanup.push({
    fn: async () => {
      await sb.from("pipeline_leads").update({ draft_html: origHtml, draft_subject: origSubject }).eq("id", candidateLead.id);
    },
    label: "restore lead draft",
  });

  await sb.from("mapping_drafts").update({
    state: "approved",
    decided_at: new Date().toISOString(),
    decided_by: REP_ID,
  }).eq("id", draftId);

  // Read draft body, write it back to pipeline_leads.draft_html
  const { data: draft } = await sb.from("mapping_drafts").select("subject, body_html, lead_id").eq("id", draftId).maybeSingle();
  await sb.from("pipeline_leads").update({
    draft_html: draft.body_html,
    draft_subject: draft.subject,
  }).eq("id", draft.lead_id);

  // Verify it landed
  const { data: leadAfter } = await sb.from("pipeline_leads").select("draft_html, draft_subject").eq("id", candidateLead.id).maybeSingle();
  if (leadAfter?.draft_subject !== draft.subject) throw new Error("subject didn't land");
  pass("decideDraft (approve)", `→ pipeline_leads.draft_subject set to "${(leadAfter.draft_subject ?? "").slice(0, 40)}"`);
} catch (e) { fail("decideDraft (approve)", e.message); }

// 5. Run evolution loop (uses the LLM)
try {
  const drafts = await sb.from("mapping_drafts").select("subject, body_html, match_reason, state, reject_reason").eq("target_id", targetId).order("created_at", { ascending: false }).limit(40);
  const { data: target } = await sb.from("mapping_targets").select("*").eq("id", targetId).maybeSingle();
  const stats = {
    total: drafts.data?.length ?? 0,
    approved: (drafts.data ?? []).filter((d) => d.state === "approved").length,
    rejected: (drafts.data ?? []).filter((d) => d.state === "rejected").length,
  };
  const userPrompt = `Target label: ${target.label}\nCurrent spec: ${JSON.stringify(target.spec)}\n\nDraft outcomes (most recent ${stats.total}):\n- approved: ${stats.approved}\n- rejected: ${stats.rejected}\n\nPropose ONE revision. Strict JSON:\n{ "kind": "spec_revision"|"template_revision"|"guidelines_revision"|"strategy_note", "rationale": "...", "diff": {...} }`;
  const raw = await llm("Propose one high-leverage revision. Be specific.", userPrompt, { json: true, max_tokens: 1500, temperature: 0.3 });
  const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""));
  if (!parsed.kind || !parsed.rationale) throw new Error("malformed revision");

  const { data: ev, error: evErr } = await sb.from("mapping_evolutions").insert({
    target_id: targetId,
    kind: parsed.kind,
    diff: parsed.diff ?? {},
    proposed_by: "congress",
    rationale: parsed.rationale,
  }).select("id").single();
  if (evErr) throw evErr;
  cleanup.push({ fn: () => sb.from("mapping_evolutions").delete().eq("id", ev.id), label: "delete evolution" });
  pass("runEvolutionLoop", `→ ${parsed.kind}: "${parsed.rationale.slice(0, 80)}"`);
} catch (e) { fail("runEvolutionLoop", e.message); }

// Cleanup
console.log("\n--- cleanup ---");
for (const c of cleanup.reverse()) {
  try { await c.fn(); console.log(`✓ ${c.label}`); }
  catch (e) { console.log(`✗ ${c.label}: ${e?.message ?? e}`); }
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
