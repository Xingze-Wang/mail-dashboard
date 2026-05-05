// src/lib/mapping.ts
//
// The mapping team's workflow library:
//   - createTarget       — capture a target spec from the bot's interview
//   - findCandidateLeads — match leads from pipeline_leads against a spec
//   - draftForLead       — write a personalized email for one lead
//   - decideDraft        — apply the mapping person's approve/reject/edit
//   - runEvolutionLoop   — congress-driven target+template revision
//
// All four are admin/mapping-scoped. The Lark bot calls them via
// helper-tools dispatch.

import { supabase } from "@/lib/db";
import { llmChat } from "@/lib/llm-proxy";

const DRAFT_MODEL = "claude-sonnet-4.6";
const EVOLUTION_MODEL = "claude-opus-4.7";

// ── Target spec shape ────────────────────────────────────────────────
//
// Stored as jsonb so we can extend without migration. Bot interview
// produces this; congress can revise individual fields over time.
export interface TargetSpec {
  vertical?: string;                 // "lifesci" | "robotics" | "infra" | "foundation_models" | ...
  topic_keywords?: string[];          // free-form research topic terms
  schools?: string[];                  // explicit school list, or empty for any
  school_tier?: 1 | 2 | 3;             // bucket
  geo?: "cn" | "edu" | "other" | "any";
  h_index_min?: number;
  citation_count_min?: number;
  custom_filters?: string;             // free-text filter the bot writes for hard cases
}

export interface MappingTarget {
  id: string;
  owner_rep_id: number;
  label: string;
  spec: TargetSpec;
  canonical_template_html: string | null;
  candidate_template_html: string | null;
  candidate_active: boolean;
  guidelines: string | null;
  active: boolean;
  created_at: string;
}

// ── Create target ────────────────────────────────────────────────────

export async function createTarget(input: {
  owner_rep_id: number;
  label: string;
  spec: TargetSpec;
  guidelines?: string;
}): Promise<{ ok: boolean; target_id?: string; error?: string }> {
  if (!input.label || input.label.length < 4 || input.label.length > 200) {
    return { ok: false, error: "label must be 4-200 chars" };
  }
  const { data, error } = await supabase
    .from("mapping_targets")
    .insert({
      owner_rep_id: input.owner_rep_id,
      label: input.label,
      spec: input.spec,
      guidelines: input.guidelines ?? null,
    })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? "insert failed" };
  return { ok: true, target_id: data.id as string };
}

// ── Find candidate leads ─────────────────────────────────────────────
//
// Match a target spec against pipeline_leads. Today this is a SQL
// filter — fine for MVP. Later we can add embedding-similarity match
// for topic_keywords once vector search is wired.

export async function findCandidateLeads(opts: {
  target_id: string;
  limit?: number;
}): Promise<{ ok: boolean; leads?: Array<{ id: string; title: string | null; author_name: string | null; author_email: string; matched_via: string[] }>; error?: string }> {
  const { data: target } = await supabase
    .from("mapping_targets")
    .select("spec, owner_rep_id")
    .eq("id", opts.target_id)
    .maybeSingle();
  if (!target) return { ok: false, error: "target not found" };
  const spec = target.spec as TargetSpec;
  const limit = Math.max(1, Math.min(50, opts.limit ?? 10));

  let q = supabase
    .from("pipeline_leads")
    .select("id, title, author_name, author_email, citation_count, matched_directions, school_tier, status")
    .eq("status", "ready")
    .limit(limit * 3); // overshoot; we re-rank below

  if (spec.school_tier) q = q.eq("school_tier", spec.school_tier);
  if (spec.citation_count_min) q = q.gte("citation_count", spec.citation_count_min);
  if (spec.geo === "cn") q = q.like("author_email", "%.cn");
  if (spec.geo === "edu") q = q.like("author_email", "%.edu");

  const { data, error } = await q;
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) return { ok: true, leads: [] };

  // Soft-rank by topic_keywords overlap with title + matched_directions.
  const kws = (spec.topic_keywords ?? []).map((k) => k.toLowerCase());
  const ranked = data.map((lead) => {
    const matched: string[] = [];
    const blob = `${lead.title ?? ""} ${(Array.isArray(lead.matched_directions) ? lead.matched_directions.join(" ") : (lead.matched_directions ?? ""))}`.toLowerCase();
    for (const k of kws) if (blob.includes(k)) matched.push(k);
    if (spec.schools) {
      const emailDomain = (lead.author_email as string)?.split("@")[1] ?? "";
      for (const s of spec.schools) if (emailDomain.toLowerCase().includes(s.toLowerCase())) matched.push(`school:${s}`);
    }
    return { lead, score: matched.length, matched };
  }).sort((a, b) => b.score - a.score).slice(0, limit);

  return { ok: true, leads: ranked.map((r) => ({
    id: r.lead.id as string,
    title: (r.lead.title as string | null) ?? null,
    author_name: (r.lead.author_name as string | null) ?? null,
    author_email: r.lead.author_email as string,
    matched_via: r.matched,
  })) };
}

// ── Draft for one lead ───────────────────────────────────────────────

export async function draftForLead(opts: {
  target_id: string;
  lead_id: string;
}): Promise<{ ok: boolean; draft_id?: string; subject?: string; body_html?: string; error?: string }> {
  const [{ data: target }, { data: lead }] = await Promise.all([
    supabase.from("mapping_targets").select("*").eq("id", opts.target_id).maybeSingle(),
    supabase.from("pipeline_leads").select("id, title, author_name, author_email, abstract, matched_directions").eq("id", opts.lead_id).maybeSingle(),
  ]);
  if (!target) return { ok: false, error: "target not found" };
  if (!lead) return { ok: false, error: "lead not found" };

  const tmpl = (target.canonical_template_html ?? target.candidate_template_html) as string | null;
  const guidelines = target.guidelines as string | null;

  // Build the draft prompt. Use the canonical template as a *guide* but
  // ask the model to personalize per-lead. If no template yet, ask the
  // model to write from scratch given the target's vertical + spec.
  const userPrompt = `## Target
Label: ${target.label}
Spec: ${JSON.stringify(target.spec)}
${guidelines ? `Guidelines (do NOT violate):\n${guidelines}\n` : ""}

## Lead
Name: ${lead.author_name}
Email: ${lead.author_email}
Title: ${lead.title}
${lead.abstract ? `Abstract: ${(lead.abstract as string).slice(0, 800)}\n` : ""}

${tmpl ? `## Existing template (current best for this target — adapt, don't copy verbatim)\n${tmpl}\n` : "## No template yet — write a tight personalized intro"}

## Output
Strict JSON, no preamble:
{ "subject": "<short subject in the same language as the lead's title>", "body_html": "<email body in HTML, 2-4 paragraphs, personalized to this lead>", "match_reason": "<1 sentence: why this lead fits the target>" }`;

  let parsed: { subject: string; body_html: string; match_reason: string };
  try {
    const r = await llmChat({
      model: DRAFT_MODEL,
      system: "你是一个 sales 助手, 给奇绩算力的潜在客户写邮件. 不撒谎, 不 over-commit, 不报价格. 邮件风格朴实直接, 100-200 字.",
      user: userPrompt,
      json: true,
      max_tokens: 1500,
      temperature: 0.4,
      timeoutMs: 60_000,
    });
    parsed = JSON.parse(r.text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""));
  } catch (err) {
    return { ok: false, error: `draft model failed: ${String(err).slice(0, 120)}` };
  }
  if (!parsed.subject || !parsed.body_html) return { ok: false, error: "model returned malformed draft" };

  const { data: row, error: rowErr } = await supabase
    .from("mapping_drafts")
    .insert({
      target_id: opts.target_id,
      lead_id: opts.lead_id,
      subject: parsed.subject,
      body_html: parsed.body_html,
      match_reason: parsed.match_reason,
      state: "pending",
    })
    .select("id")
    .single();
  if (rowErr || !row) return { ok: false, error: rowErr?.message ?? "draft insert failed" };

  return { ok: true, draft_id: row.id as string, subject: parsed.subject, body_html: parsed.body_html };
}

// ── Approve / reject / edit ──────────────────────────────────────────

export async function decideDraft(opts: {
  draft_id: string;
  decision: "approve" | "reject" | "edit_and_approve";
  decided_by: number;
  edited_subject?: string;
  edited_body_html?: string;
  reject_reason?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const { data: draft } = await supabase
    .from("mapping_drafts")
    .select("id, lead_id, subject, body_html, target_id, state")
    .eq("id", opts.draft_id)
    .maybeSingle();
  if (!draft) return { ok: false, error: "draft not found" };
  if (draft.state !== "pending") return { ok: false, error: `draft is in state '${draft.state}'` };

  const finalSubject = opts.decision === "edit_and_approve" ? (opts.edited_subject ?? draft.subject) : draft.subject;
  const finalBody = opts.decision === "edit_and_approve" ? (opts.edited_body_html ?? draft.body_html) : draft.body_html;

  const newState =
    opts.decision === "approve" ? "approved" :
    opts.decision === "edit_and_approve" ? "edited_and_approved" :
    "rejected";

  await supabase.from("mapping_drafts").update({
    state: newState,
    decided_at: new Date().toISOString(),
    decided_by: opts.decided_by,
    edited_subject: opts.decision === "edit_and_approve" ? opts.edited_subject : null,
    edited_body_html: opts.decision === "edit_and_approve" ? opts.edited_body_html : null,
    reject_reason: opts.decision === "reject" ? opts.reject_reason : null,
  }).eq("id", opts.draft_id);

  // On approve, write the (possibly-edited) draft into pipeline_leads
  // so it joins the normal sales flow.
  if (newState === "approved" || newState === "edited_and_approved") {
    await supabase.from("pipeline_leads").update({
      draft_html: finalBody,
      draft_subject: finalSubject,
      // If the draft was meant to be sent, status moves to "ready"; we don't
      // change assigned_rep_id here because the mapping person typically
      // owns these leads already.
    }).eq("id", draft.lead_id);
  }

  return { ok: true };
}

// ── Congress-driven evolution ────────────────────────────────────────
//
// For one target, look at recent drafts (approve/reject ratio + reject
// reasons + outcome metrics) and have a small panel propose ONE
// revision: spec, template, or guidelines. Logs the proposal to
// mapping_evolutions; doesn't auto-apply (mapping person reviews).

export async function runEvolutionLoop(opts: {
  target_id: string;
}): Promise<{ ok: boolean; proposed?: { kind: string; rationale: string; diff: Record<string, unknown> }; error?: string }> {
  const { data: target } = await supabase.from("mapping_targets").select("*").eq("id", opts.target_id).maybeSingle();
  if (!target) return { ok: false, error: "target not found" };

  const { data: drafts } = await supabase
    .from("mapping_drafts")
    .select("subject, body_html, match_reason, state, reject_reason, created_at, decided_at")
    .eq("target_id", opts.target_id)
    .order("created_at", { ascending: false })
    .limit(40);

  const stats = {
    total: drafts?.length ?? 0,
    pending: (drafts ?? []).filter((d) => d.state === "pending").length,
    approved: (drafts ?? []).filter((d) => d.state === "approved").length,
    edited_and_approved: (drafts ?? []).filter((d) => d.state === "edited_and_approved").length,
    rejected: (drafts ?? []).filter((d) => d.state === "rejected").length,
    reject_reasons: (drafts ?? []).filter((d) => d.state === "rejected").map((d) => d.reject_reason).filter(Boolean),
  };

  const userPrompt = `## Target review

You are reviewing one mapping target's recent performance to propose ONE revision.

Target label: ${target.label}
Current spec: ${JSON.stringify(target.spec)}
Current guidelines: ${target.guidelines ?? "(none)"}
Current canonical template: ${(target.canonical_template_html as string | null)?.slice(0, 500) ?? "(none yet)"}

## Draft outcomes (most recent ${stats.total})
- approved as-is: ${stats.approved}
- edited then approved: ${stats.edited_and_approved}
- rejected: ${stats.rejected}
${stats.reject_reasons.length > 0 ? "- reject reasons:\n" + stats.reject_reasons.slice(0, 8).map((r) => `   • ${r}`).join("\n") : ""}

## Task

Propose ONE specific revision, the highest-leverage one given the data:
- "spec_revision": tighten or broaden the target spec (vertical / topic_keywords / school_tier / etc)
- "template_revision": revise the canonical template
- "guidelines_revision": add a do-not-do rule based on rejection patterns
- "strategy_note": just a one-paragraph observation, no code change yet

Output strict JSON:
{
  "kind": "spec_revision" | "template_revision" | "guidelines_revision" | "strategy_note",
  "rationale": "1-2 sentences why this is the most useful revision now",
  "diff": <jsonb describing the change. For spec_revision: {field: newvalue}. For template_revision: {template_html: "..."}. For guidelines: {guidelines: "..."}. For strategy_note: {note: "..."}>
}`;

  let parsed: { kind: string; rationale: string; diff: Record<string, unknown> };
  try {
    const r = await llmChat({
      model: EVOLUTION_MODEL,
      system: "You are an analyst proposing ONE high-leverage revision to a mapping target's strategy. Be specific, cite the data, don't propose multiple changes at once.",
      user: userPrompt,
      json: true,
      max_tokens: 2000,
      temperature: 0.3,
      timeoutMs: 60_000,
    });
    parsed = JSON.parse(r.text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""));
  } catch (err) {
    return { ok: false, error: `evolution model failed: ${String(err).slice(0, 120)}` };
  }
  if (!parsed.kind || !parsed.rationale) return { ok: false, error: "model returned malformed revision" };

  await supabase.from("mapping_evolutions").insert({
    target_id: opts.target_id,
    kind: parsed.kind,
    diff: parsed.diff,
    proposed_by: "congress",
    rationale: parsed.rationale,
  });

  return { ok: true, proposed: parsed };
}
