import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";
import { llmChat } from "@/lib/llm-proxy";
import { beijingDaysAgoStartUtc } from "@/lib/override-quota";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/help/execute
 * Body: {
 *   conversationId?: string,          // if provided, appends a tool message
 *   proposal: { action, ...params },  // what the LLM suggested
 * }
 *
 * Runs a tool proposal that the user has explicitly confirmed by
 * clicking the Confirm button in the helper UI. The LLM NEVER runs
 * actions directly — it only suggests; this route is the only
 * execution surface. Every action here funnels through existing
 * authenticated endpoints (batch-send, PATCH pipeline, lead/correct),
 * so per-rep scoping, quota caps, blocklist checks all apply.
 *
 * The conversation gets a `tool` message recording what ran + the
 * result, so the thread history is auditable.
 */

// Bumped 2026-05-14 alongside trust-tier bulkBatchMax (mature/admin
// already 200; the bot's own action handler was the bottleneck).
// Never execute more than this in one proposal regardless of what the
// LLM asks for — the trust-tier per-rep cap is the per-rep ceiling.
const HARD_CAP = 200;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

async function logToolMessage(
  conversationId: string | null,
  proposal: unknown,
  result: unknown,
) {
  if (!conversationId) return;
  await supabase.from("helper_messages").insert({
    conversation_id: conversationId,
    role: "tool",
    text: null,
    tool_proposal: proposal,
    tool_result: result,
  });
  await supabase
    .from("helper_conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", conversationId);
}

async function doBatchSend(
  session: { repId: number; role: string },
  params: Record<string, unknown>,
  reqOrigin: string,
  cookie: string,
): Promise<{ ok: boolean; detail: Record<string, unknown> }> {
  const limit = Math.max(1, Math.min(HARD_CAP, Math.floor(Number(params.limit) || 10)));
  const explicitOverride = params.override === true;

  // Two-pass selection so "send 10" doesn't dead-end when everything's
  // <7 days old:
  //
  //   1. Fetch the rep's non-gated (created_at ≥ 7d ago) ready leads,
  //      newest first, up to `limit`. These need no override.
  //   2. If that's less than `limit`, top up from gated rows — and we
  //      pass those ids in `overrides` so batch-send actually sends
  //      them. Gated top-ups count against the 200/day cap.
  //   3. If the user explicitly said "override everything" (the LLM
  //      sets override:true on the proposal), skip step 1 and just
  //      pull the top N irrespective of age, all as overrides.
  //
  // Anchor on the Beijing-day boundary (same as override-quota) so a
  // lead created at 23:30 Beijing either lives in today's window or
  // yesterday's, never straddles depending on server TZ. Plain
  // `Date.now() - 7d` would drift against the quota check by up to 8h.
  const sevenDaysAgo = beijingDaysAgoStartUtc(7).toISOString();

  const baseQ = () => {
    let q = supabase
      .from("pipeline_leads")
      .select("id, created_at")
      .eq("status", "ready")
      .order("created_at", { ascending: false });
    if (session.role !== "admin") q = q.eq("assigned_rep_id", session.repId);
    return q;
  };

  let picked: Array<{ id: string; override: boolean }> = [];
  let selectionNote = "";

  if (explicitOverride) {
    const { data } = await baseQ().limit(limit);
    picked = (data ?? []).map((l) => ({ id: l.id, override: true }));
    selectionNote = `override=true (user-requested): ${picked.length} leads`;
  } else {
    // Prefer non-gated first.
    const { data: nonGated } = await baseQ().lte("created_at", sevenDaysAgo).limit(limit);
    picked = (nonGated ?? []).map((l) => ({ id: l.id, override: false }));
    const need = limit - picked.length;
    if (need > 0) {
      // Top up with gated; these'll go out as overrides.
      const { data: gated } = await baseQ().gt("created_at", sevenDaysAgo).limit(need);
      picked = [
        ...picked,
        ...(gated ?? []).map((l) => ({ id: l.id, override: true })),
      ];
      selectionNote = `${picked.filter((p) => !p.override).length} non-gated + ${picked.filter((p) => p.override).length} gated (override)`;
    } else {
      selectionNote = `${picked.length} non-gated`;
    }
  }

  if (picked.length === 0) {
    return { ok: false, detail: { error: "No matching leads" } };
  }

  const ids = picked.map((p) => p.id);
  const overrides = picked.filter((p) => p.override).map((p) => p.id);

  const res = await fetch(`${reqOrigin}/api/pipeline/batch-send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ ids, overrides }),
  });
  const detail = await res.json().catch(() => ({}));
  return { ok: res.ok, detail: { ...detail, selection: selectionNote } };
}

async function doSkip(
  session: { repId: number; role: string },
  params: Record<string, unknown>,
  reqOrigin: string,
  cookie: string,
): Promise<{ ok: boolean; detail: Record<string, unknown> }> {
  const leadId = typeof params.lead_id === "string" ? params.lead_id : null;
  if (!leadId) return { ok: false, detail: { error: "lead_id required" } };

  // Ownership check done server-side by PATCH route itself.
  const res = await fetch(`${reqOrigin}/api/pipeline/${leadId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ status: "skipped" }),
  });
  const detail = await res.json().catch(() => ({}));
  return { ok: res.ok, detail };
}

async function doFlag(
  session: { repId: number; role: string },
  params: Record<string, unknown>,
  reqOrigin: string,
  cookie: string,
): Promise<{ ok: boolean; detail: Record<string, unknown> }> {
  const leadId = typeof params.lead_id === "string" ? params.lead_id : null;
  const type = typeof params.type === "string" ? params.type : null;
  const severity = params.severity === "hard" ? "hard" : "soft";
  const reason = typeof params.reason === "string" ? params.reason.slice(0, 500) : null;
  if (!leadId || !type) return { ok: false, detail: { error: "lead_id + type required" } };
  // Hard flags require senior/admin — let the /api/lead/correct route decide.
  const res = await fetch(`${reqOrigin}/api/lead/correct`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ leadId, type, severity, reason }),
  });
  const detail = await res.json().catch(() => ({}));
  return { ok: res.ok, detail };
}

async function doBulkFlag(
  session: { repId: number; role: string },
  params: Record<string, unknown>,
  reqOrigin: string,
  cookie: string,
): Promise<{ ok: boolean; detail: Record<string, unknown> }> {
  const ids = Array.isArray(params.lead_ids) ? params.lead_ids.filter((x) => typeof x === "string").slice(0, 20) as string[] : [];
  const type = typeof params.type === "string" ? params.type : null;
  // Bulk flag is SOFT only. Hard flags have to be one-by-one so each
  // block decision is explicit.
  const reason = typeof params.reason === "string" ? params.reason.slice(0, 500) : null;
  if (ids.length === 0 || !type) {
    return { ok: false, detail: { error: "lead_ids + type required" } };
  }
  let ok = 0, fail = 0;
  const errors: string[] = [];
  for (const leadId of ids) {
    const r = await fetch(`${reqOrigin}/api/lead/correct`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ leadId, type, severity: "soft", reason }),
    });
    if (r.ok) ok++;
    else {
      fail++;
      const d = await r.json().catch(() => ({}));
      errors.push(`${leadId.slice(0, 8)}: ${d.error ?? r.status}`);
    }
  }
  return { ok: fail === 0, detail: { flagged: ok, failed: fail, errors } };
}

async function doRedraft(
  session: { repId: number; role: string },
  params: Record<string, unknown>,
  reqOrigin: string,
  cookie: string,
): Promise<{ ok: boolean; detail: Record<string, unknown> }> {
  const leadId = typeof params.lead_id === "string" ? params.lead_id : null;
  const direction = typeof params.direction === "string" ? params.direction.slice(0, 200) : null;
  if (!leadId) return { ok: false, detail: { error: "lead_id required" } };

  // Load the lead (ownership enforced by the /api/pipeline/[id] GET).
  const leadRes = await fetch(`${reqOrigin}/api/pipeline/${leadId}`, {
    headers: { cookie },
  });
  if (!leadRes.ok) {
    const d = await leadRes.json().catch(() => ({}));
    return { ok: false, detail: { error: d.error ?? `lead fetch ${leadRes.status}` } };
  }
  const lead = await leadRes.json();
  if (!lead?.title || !lead?.abstract) {
    return { ok: false, detail: { error: "lead missing title/abstract" } };
  }

  // Call our internal LLM proxy to regenerate the draft.
  // We reuse the same intro-generation prompt the scanner uses —
  // /api/scorer/rubric exposes it, but simpler to just run llmChat
  // inline here with a short prompt.
  const { llmChat } = await import("@/lib/llm-proxy");
  const system = `你是奇绩算力的邮件撰稿助手. 给定一篇 arXiv 论文和一个"方向" (如"更短", "更直接", "提到算力具体额度"), 重写邮件正文. 返回 HTML <p> 段落, 不要 markdown.`;
  const user = `论文标题: ${lead.title}
摘要: ${(lead.abstract as string).slice(0, 800)}
作者: ${lead.authorName ?? ""}
原方向: ${direction ?? "(no direction given — just tighten and clarify)"}

只返回新的 HTML 邮件正文 (3 段, 用 <p>...</p>). 开头称呼用 "${lead.firstName ?? lead.authorName ?? "你"}你好,".`;
  let newHtml = "";
  try {
    const r = await llmChat({ model: "gemini-3-flash", system, user, temperature: 0.5, max_tokens: 900, timeoutMs: 25_000 });
    newHtml = r.text.trim();
  } catch (e) {
    return { ok: false, detail: { error: `redraft LLM failed: ${e instanceof Error ? e.message : String(e)}` } };
  }
  if (!newHtml.includes("<p>")) newHtml = `<p>${newHtml.replace(/\n+/g, "</p>\n<p>")}</p>`;

  // Save via PATCH /api/pipeline/[id].
  const patchRes = await fetch(`${reqOrigin}/api/pipeline/${leadId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ draftHtml: newHtml }),
  });
  if (!patchRes.ok) {
    const d = await patchRes.json().catch(() => ({}));
    return { ok: false, detail: { error: d.error ?? "patch failed" } };
  }
  return { ok: true, detail: { redrafted: true, preview: newHtml.slice(0, 200) } };
}

async function doReviewNext(): Promise<{ ok: boolean; detail: Record<string, unknown> }> {
  // review_next is a frontend-only action (navigate to Review mode).
  // Server-side it's a no-op that just confirms back; the UI handles the actual navigation on receipt.
  return { ok: true, detail: { navigate: "/pipeline#mode=review" } };
}

async function doRememberAboutRep(
  session: { repId: number; role: string },
  params: Record<string, unknown>,
): Promise<{ ok: boolean; detail: Record<string, unknown> }> {
  // Write a long-term memory about this rep. Sales can write rep-scoped
  // memories about themselves; admin can additionally write org-wide
  // memories. We deliberately gate `scope: "org"` to admin so a rep can't
  // smuggle org-level guidance into the team prompt.
  const kindRaw = typeof params.kind === "string" ? params.kind : "other";
  const allowedKinds = ["rep_pref", "tactic", "self_critique", "other"] as const;
  type Kind = (typeof allowedKinds)[number];
  const kind: Kind = (allowedKinds as readonly string[]).includes(kindRaw) ? (kindRaw as Kind) : "other";
  const body = typeof params.body === "string" ? params.body.trim() : "";
  if (!body || body.length < 3) {
    return { ok: false, detail: { error: "body must be a non-empty string ≥3 chars" } };
  }
  if (body.length > 600) {
    return { ok: false, detail: { error: "body too long — keep memory entries under 600 chars; learnings should be a sentence, not a paragraph" } };
  }
  const scope = params.scope === "org" && session.role === "admin" ? "org" : "rep";
  const scope_rep_id = scope === "org" ? null : session.repId;

  // Lazy-import so we don't pay the helper-learnings module load cost on
  // every action. Same shape as the doRedraft llmChat lazy-import below.
  const { recordLearning } = await import("@/lib/helper-learnings");
  const learning = await recordLearning({
    scope_rep_id,
    kind,
    body,
    confidence: 0.8,  // helper-suggested + rep-confirmed
    evidence: { source: "helper_chat", session_rep: session.repId },
  });
  if (!learning) {
    return { ok: false, detail: { error: "failed to record learning — check server logs" } };
  }
  return {
    ok: true,
    detail: {
      learning_id: learning.id,
      kind: learning.kind,
      scope: learning.scope_rep_id == null ? "org" : "rep",
      body: learning.body,
    },
  };
}

/**
 * Admin correction → durable self-critique memory + sample QA so admin
 * sees how Leon will answer next time. Records to helper_learnings with
 * kind='self_critique', org-scoped by default (most factual corrections
 * apply to every rep, not just the one who happened to be in the chat).
 *
 * Returns sample_answer: an LLM-rendered short answer that respects the
 * correction. This is the "verify in chat before walking away" loop the
 * user asked for — adminclap can see the memory works before trusting.
 */
async function doLearnFromAdminCorrection(
  session: { repId: number; role: string },
  params: Record<string, unknown>,
): Promise<{ ok: boolean; detail: Record<string, unknown> }> {
  if (session.role !== "admin") {
    return { ok: false, detail: { error: "admin only — only admin can correct Leon's facts" } };
  }
  const whatISaid = typeof params.what_i_said === "string" ? params.what_i_said.trim().slice(0, 600) : "";
  const correction = typeof params.correction === "string" ? params.correction.trim().slice(0, 600) : "";
  if (!correction || correction.length < 3) {
    return { ok: false, detail: { error: "correction must be ≥3 chars — what should I have said?" } };
  }
  const scopeRaw = params.scope === "rep" ? "rep" : "org"; // default org
  const scope_rep_id = scopeRaw === "rep" ? session.repId : null;

  const body = whatISaid
    ? `When asked something like: "${whatISaid.slice(0, 200)}", do NOT answer the way I did before. Correct answer: ${correction}`
    : `Correction from admin: ${correction}`;

  const { recordLearning } = await import("@/lib/helper-learnings");
  const learning = await recordLearning({
    scope_rep_id,
    kind: "self_critique",
    body,
    confidence: 0.95,  // admin-stated facts get high confidence
    evidence: {
      source: "admin_correction",
      corrected_by_rep: session.repId,
      what_i_said: whatISaid || null,
      correction,
      at: new Date().toISOString(),
    },
  });
  if (!learning) {
    return { ok: false, detail: { error: "failed to save correction — check server logs" } };
  }

  // Sample-QA: run a small LLM call to demo how Leon would answer the
  // sample_question NOW with the new memory in context. Lets admin
  // verify the correction took without waiting for the next real ask.
  const sampleQ = typeof params.sample_question === "string" ? params.sample_question.trim().slice(0, 300) : "";
  let sampleAnswer: string | null = null;
  if (sampleQ) {
    try {
      const { llmChat } = await import("@/lib/llm-proxy");
      const sys = `You are Leon, the sales-team helper bot. Admin just corrected you. Respect the correction below in all future answers.

Correction (high confidence, from admin):
${body}

Answer the user's question briefly (1-2 sentences) in the same language as the question. If the correction directly applies, use the corrected fact. If not, answer normally but stay consistent with the correction's spirit.`;
      const out = await llmChat({
        model: "claude-haiku-4-5",
        system: sys,
        user: sampleQ,
        max_tokens: 250,
        temperature: 0.2,
        timeoutMs: 12_000,
      });
      sampleAnswer = (out.text || "").trim() || null;
    } catch (err) {
      console.warn("learn_from_admin_correction: sample-QA failed (non-blocking):", err);
    }
  }

  return {
    ok: true,
    detail: {
      learning_id: learning.id,
      scope: scopeRaw,
      saved: body,
      sample_question: sampleQ || null,
      sample_answer: sampleAnswer,
      note: sampleAnswer
        ? "Saved. Sample answer with new memory is in sample_answer — verify it sounds right."
        : "Saved. Provide a sample_question next time if you want me to demo the new behavior.",
    },
  };
}

/**
 * Admin asks "what have I corrected you on?" — list recent self_critique
 * learnings, both org-wide and (optionally) rep-scoped. Lets admin see
 * their feedback is being persisted.
 */
async function doRecallMyMistakes(
  session: { repId: number; role: string },
  params: Record<string, unknown>,
): Promise<{ ok: boolean; detail: Record<string, unknown> }> {
  const limit = Math.max(1, Math.min(20, Number(params.limit) || 5));
  const scope = params.scope === "rep" ? "rep" : params.scope === "org" ? "org" : "all";

  const { supabase } = await import("@/lib/db");
  let q = supabase
    .from("helper_learnings")
    .select("id, body, scope_rep_id, created_at, evidence, confidence")
    .eq("kind", "self_critique")
    .is("superseded_at", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (scope === "rep") q = q.eq("scope_rep_id", session.repId);
  else if (scope === "org") q = q.is("scope_rep_id", null);
  const { data, error } = await q;
  if (error) {
    return { ok: false, detail: { error: error.message } };
  }
  return {
    ok: true,
    detail: {
      count: data?.length ?? 0,
      critiques: (data ?? []).map((d) => ({
        id: d.id,
        body: d.body,
        scope: d.scope_rep_id == null ? "org" : "rep",
        created_at: d.created_at,
        confidence: d.confidence,
        from_admin: !!(d.evidence as { source?: string } | null)?.source && (d.evidence as { source?: string }).source === "admin_correction",
      })),
    },
  };
}

async function doTrackPrediction(
  session: { repId: number; role: string },
  params: Record<string, unknown>,
): Promise<{ ok: boolean; detail: Record<string, unknown> }> {
  // Helper proposed it, rep confirmed → row in helper_predictions.
  // Cron resolver fires past target_deadline and writes a self_critique
  // to helper_learnings on misses. See src/lib/predictions.ts.
  const claim = typeof params.claim === "string" ? params.claim.trim() : "";
  const targetEvent = typeof params.targetEvent === "string" ? params.targetEvent : "";
  const allowed = ["no_reply", "no_wechat", "reply", "wechat"];
  if (claim.length < 5 || claim.length > 500) {
    return { ok: false, detail: { error: "claim must be 5-500 chars" } };
  }
  if (!allowed.includes(targetEvent)) {
    return { ok: false, detail: { error: `targetEvent must be one of ${allowed.join("|")}` } };
  }
  const horizonDays = Math.max(1, Math.min(30, Number(params.horizonDays) || 7));
  const targetDeadline = new Date(Date.now() + horizonDays * 86_400_000);

  const { recordPrediction } = await import("@/lib/predictions");
  // Derive an idempotency key from the request shape so a tool re-run
  // (LLM retried the call, user double-clicked the bubble, etc.)
  // collapses to one helper_predictions row. Migration 072 enforces
  // uniqueness; this just produces the key.
  const { createHash } = await import("node:crypto");
  const seed = [
    session.repId,
    claim.trim(),
    targetEvent,
    typeof params.targetLeadId === "string" ? params.targetLeadId : "",
    typeof params.targetRecipient === "string" ? params.targetRecipient : "",
  ].join("");
  const requestId = createHash("sha256").update(seed).digest("hex").slice(0, 32);
  const row = await recordPrediction({
    repId: session.repId,
    claim,
    targetEvent: targetEvent as "no_reply" | "no_wechat" | "reply" | "wechat",
    targetLeadId: typeof params.targetLeadId === "string" ? params.targetLeadId : null,
    targetRecipient: typeof params.targetRecipient === "string" ? params.targetRecipient : null,
    targetDeadline,
    requestId,
  });
  if (!row) return { ok: false, detail: { error: "insert failed — check server logs" } };
  return {
    ok: true,
    detail: {
      prediction_id: row.id,
      target_event: row.target_event,
      target_deadline: row.target_deadline,
      horizon_days: horizonDays,
    },
  };
}

/**
 * reassign_lead — single-lead owner change with email cascade. Same
 * data-model as the /api/pipeline/[id] PATCH path: pipeline_leads
 * .assigned_rep_id flips, emails.rep_id cascades on thread_id,
 * actor_rep_id stays untouched (send-history is immutable).
 *
 * Admin-only. Sales role gets a clear refusal so the helper doesn't
 * silently no-op.
 */
async function doReassignLead(
  session: { repId: number; role: string },
  params: Record<string, unknown>,
): Promise<{ ok: boolean; detail: Record<string, unknown> }> {
  if (session.role !== "admin") {
    return { ok: false, detail: { error: "admin only" } };
  }
  const leadId = typeof params.lead_id === "string" ? params.lead_id : "";
  const toRepId = Number(params.to_rep_id);
  if (!leadId || !Number.isFinite(toRepId)) {
    return { ok: false, detail: { error: "lead_id and to_rep_id required" } };
  }

  // Confirm the lead + target rep both exist before any writes.
  const [leadRes, repRes] = await Promise.all([
    supabase.from("pipeline_leads").select("id, thread_id, assigned_rep_id").eq("id", leadId).maybeSingle(),
    supabase.from("sales_reps").select("id, name, active").eq("id", toRepId).maybeSingle(),
  ]);
  if (!leadRes.data) return { ok: false, detail: { error: "lead not found" } };
  if (!repRes.data) return { ok: false, detail: { error: "target rep not found" } };
  if (repRes.data.active === false) {
    return { ok: false, detail: { error: `rep ${repRes.data.name} is inactive` } };
  }
  if (leadRes.data.assigned_rep_id === toRepId) {
    return { ok: true, detail: { reassigned: 0, note: `already assigned to ${repRes.data.name}` } };
  }

  const { error: leadErr } = await supabase
    .from("pipeline_leads")
    .update({ assigned_rep_id: toRepId })
    .eq("id", leadId);
  if (leadErr) return { ok: false, detail: { error: leadErr.message } };

  let cascaded = 0;
  if (leadRes.data.thread_id) {
    const { error: emailErr, count } = await supabase
      .from("emails")
      .update({ rep_id: toRepId }, { count: "exact" })
      .eq("thread_id", leadRes.data.thread_id);
    if (emailErr) console.warn("reassign_lead email cascade failed", { leadId, err: emailErr.message });
    else cascaded = count ?? 0;
  }

  return {
    ok: true,
    detail: {
      reassigned: 1,
      emailsCascaded: cascaded,
      from_rep_id: leadRes.data.assigned_rep_id,
      to_rep: { id: repRes.data.id, name: repRes.data.name },
    },
  };
}

/**
 * reassign_leads_bulk — apply a small ordered rule set. Helper passes
 * { rules: [{ when, to_rep_id }, ...] }. We normalize to the shape
 * /api/admin/reassign-rules expects, ALWAYS run preview first to
 * compute the move count, then apply only if helper supplied
 * confirm: true (which it gets from the UI confirm button click).
 *
 * Two-phase pattern: when confirm=false (helper's first call from
 * the proposal card), we return the preview as detail and ok=true
 * but with applied=false. The UI shows the count + sample. On the
 * actual confirm click, helper-bot resends with confirm=true.
 *
 * Admin-only.
 */
async function doReassignLeadsBulk(
  session: { repId: number; role: string },
  params: Record<string, unknown>,
): Promise<{ ok: boolean; detail: Record<string, unknown> }> {
  if (session.role !== "admin") {
    return { ok: false, detail: { error: "admin only" } };
  }
  const rules = Array.isArray(params.rules) ? params.rules : [];
  if (rules.length === 0 || rules.length > 5) {
    return { ok: false, detail: { error: "rules[] must have 1-5 entries" } };
  }

  // Normalize to the shape that /lib reassignment expects.
  type Predicate = { geo?: "cn" | "edu" | "other"; schoolTier?: number; leadTier?: "strong" | "normal"; currentRepId?: number | null };
  type Rule = { when: Predicate; toRepId: number };
  const norm: Rule[] = [];
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i] as Record<string, unknown>;
    if (!r || typeof r !== "object") return { ok: false, detail: { error: `rule ${i}: not an object` } };
    const toRepId = Number(r.to_rep_id);
    if (!Number.isFinite(toRepId)) return { ok: false, detail: { error: `rule ${i}: to_rep_id required` } };
    const when = (r.when ?? {}) as Record<string, unknown>;
    if (Object.keys(when).length === 0) return { ok: false, detail: { error: `rule ${i}: when must have at least one field` } };
    const np: Predicate = {};
    if (when.geo !== undefined) {
      if (!["cn", "edu", "other"].includes(String(when.geo))) return { ok: false, detail: { error: `rule ${i}: when.geo must be cn|edu|other` } };
      np.geo = when.geo as "cn" | "edu" | "other";
    }
    if (when.schoolTier !== undefined) {
      const t = Number(when.schoolTier);
      if (![1, 2, 3].includes(t)) return { ok: false, detail: { error: `rule ${i}: when.schoolTier must be 1, 2, or 3` } };
      np.schoolTier = t;
    }
    if (when.leadTier !== undefined) {
      if (!["strong", "normal"].includes(String(when.leadTier))) return { ok: false, detail: { error: `rule ${i}: when.leadTier must be strong|normal` } };
      np.leadTier = when.leadTier as "strong" | "normal";
    }
    if (when.currentRepId !== undefined) {
      if (when.currentRepId === null) np.currentRepId = null;
      else {
        const n = Number(when.currentRepId);
        if (!Number.isFinite(n)) return { ok: false, detail: { error: `rule ${i}: currentRepId must be a number or null` } };
        np.currentRepId = n;
      }
    }
    norm.push({ when: np, toRepId });
  }

  // Verify target reps. Single round trip across all of them.
  const targetIds = Array.from(new Set(norm.map((r) => r.toRepId)));
  const { data: reps } = await supabase.from("sales_reps").select("id, name, active").in("id", targetIds);
  const repMap = new Map((reps ?? []).map((r) => [r.id as number, r]));
  for (const r of norm) {
    const rep = repMap.get(r.toRepId);
    if (!rep) return { ok: false, detail: { error: `target rep ${r.toRepId} not found` } };
    if (rep.active === false) return { ok: false, detail: { error: `rep ${rep.name} is inactive` } };
  }

  // Pull leads + bucket. Cap at 5000 like /api/admin/reassign-rules does.
  const { data: leads, error: leadsErr } = await supabase
    .from("pipeline_leads")
    .select("id, title, author_email, author_name, school_tier, lead_tier, assigned_rep_id, thread_id")
    .limit(5000);
  if (leadsErr) return { ok: false, detail: { error: leadsErr.message } };

  function geoOf(email: string | null): "cn" | "edu" | "other" {
    const lower = (email ?? "").toLowerCase();
    if (lower.endsWith(".cn")) return "cn";
    if (lower.endsWith(".edu") || lower.endsWith(".edu.cn")) return "edu";
    return "other";
  }
  type LeadLite = { id: string; title: string | null; author_email: string | null; author_name: string | null; school_tier: number | null; lead_tier: string | null; assigned_rep_id: number | null; thread_id: string | null };
  function matches(lead: LeadLite, when: Predicate): boolean {
    if (when.geo !== undefined && geoOf(lead.author_email) !== when.geo) return false;
    if (when.schoolTier !== undefined && lead.school_tier !== when.schoolTier) return false;
    if (when.leadTier !== undefined && lead.lead_tier !== when.leadTier) return false;
    if (when.currentRepId !== undefined) {
      if (when.currentRepId === null && lead.assigned_rep_id !== null) return false;
      if (typeof when.currentRepId === "number" && lead.assigned_rep_id !== when.currentRepId) return false;
    }
    return true;
  }

  type Bucket = { ruleIdx: number; toRepId: number; leads: LeadLite[] };
  const buckets: Bucket[] = norm.map((r, i) => ({ ruleIdx: i, toRepId: r.toRepId, leads: [] }));
  let unmatched = 0;
  for (const l of (leads ?? []) as LeadLite[]) {
    let matched = false;
    for (let i = 0; i < norm.length; i++) {
      if (matches(l, norm[i].when)) {
        if (l.assigned_rep_id !== norm[i].toRepId) buckets[i].leads.push(l);
        matched = true;
        break;
      }
    }
    if (!matched) unmatched++;
  }

  const totalToMove = buckets.reduce((s, b) => s + b.leads.length, 0);
  const perRule = buckets.map((b) => ({
    rule_index: b.ruleIdx,
    to_rep: { id: b.toRepId, name: repMap.get(b.toRepId)?.name ?? `rep ${b.toRepId}` },
    match_count: b.leads.length,
    sample: b.leads.slice(0, 3).map((l) => ({ id: l.id, author_name: l.author_name, title: (l.title ?? "").slice(0, 60) })),
  }));

  // Two-phase: first call (no confirm) returns preview only. The UI's
  // ProposalCard for reassign_leads_bulk will render this as
  // "this would move N leads, confirm to apply." On the actual click
  // it resends with confirm=true.
  if (params.confirm !== true) {
    return {
      ok: true,
      detail: {
        applied: false,
        preview: true,
        total_to_move: totalToMove,
        unmatched,
        per_rule: perRule,
      },
    };
  }

  // Phase 2 — apply. Same chunked-cascade pattern as the admin route.
  let totalReassigned = 0;
  let totalCascaded = 0;
  for (const b of buckets) {
    if (b.leads.length === 0) continue;
    const ids = b.leads.map((l) => l.id);
    const threadIds = b.leads.map((l) => l.thread_id).filter((t): t is string => !!t);

    const { error: lErr, count: lCount } = await supabase
      .from("pipeline_leads")
      .update({ assigned_rep_id: b.toRepId }, { count: "exact" })
      .in("id", ids);
    if (lErr) {
      console.warn("doReassignLeadsBulk lead update failed", { ruleIdx: b.ruleIdx, err: lErr.message });
      continue;
    }
    totalReassigned += lCount ?? 0;

    const CHUNK = 150;
    for (let i = 0; i < threadIds.length; i += CHUNK) {
      const chunk = threadIds.slice(i, i + CHUNK);
      const { error: eErr, count: eCount } = await supabase
        .from("emails")
        .update({ rep_id: b.toRepId }, { count: "exact" })
        .in("thread_id", chunk);
      if (eErr) {
        console.warn("doReassignLeadsBulk email cascade chunk failed", { ruleIdx: b.ruleIdx, i, err: eErr.message });
        continue;
      }
      totalCascaded += eCount ?? 0;
    }
  }

  return {
    ok: true,
    detail: {
      applied: true,
      reassigned: totalReassigned,
      emails_cascaded: totalCascaded,
      per_rule: perRule.map((p) => ({ ...p, applied_count: buckets[p.rule_index].leads.length })),
      unmatched,
    },
  };
}

/**
 * open_split_view — frontend-conjured overlay with the paper PDF on
 * the left and an editable draft on the right. Server-side we do two
 * things: (a) verify the lead exists + the caller owns it, (b) return
 * the bits the UI needs to render (PDF URL, title, authors, draft
 * subject/body). The UI handles rendering + Save (PATCHes via existing
 * /api/pipeline/[id]) + close.
 *
 * No DB mutation in THIS action — split-view is a viewer/editor, not
 * a send path. Saving is a separate PATCH.
 */
async function doOpenSplitView(
  session: { repId: number; role: string },
  params: Record<string, unknown>,
): Promise<{ ok: boolean; detail: Record<string, unknown> }> {
  const leadId = typeof params.lead_id === "string" ? params.lead_id : null;
  if (!leadId) return { ok: false, detail: { error: "lead_id required" } };

  const { data: lead, error } = await supabase
    .from("pipeline_leads")
    .select("id, title, authors, pdf_url, abstract, author_name, author_email, assigned_rep_id, draft_subject, draft_html, status")
    .eq("id", leadId)
    .maybeSingle();
  if (error || !lead) return { ok: false, detail: { error: "Lead not found" } };

  // Scope: non-admin must own the lead. 404-style reply so the helper
  // doesn't reveal leads outside the caller's scope.
  if (session.role !== "admin" && lead.assigned_rep_id !== session.repId) {
    return { ok: false, detail: { error: "Lead not found" } };
  }

  return {
    ok: true,
    detail: {
      openSplitView: {
        leadId: lead.id,
        title: lead.title,
        authors: lead.authors,
        pdfUrl: lead.pdf_url,
        abstract: lead.abstract,
        authorName: lead.author_name,
        authorEmail: lead.author_email,
        draftSubject: lead.draft_subject,
        draftHtml: lead.draft_html,
        status: lead.status,
      },
    },
  };
}

/**
 * build_rep_template — voice capture.
 *
 * Reads this rep's recent heavy-edit sends (draft_original vs final
 * draft), asks an LLM to produce the four templated parts in the
 * rep's own voice as JSON, and inserts an INACTIVE email_templates
 * row (name="rep_<sanitized_rep_name>"). The row is inactive by
 * default — admin reviews it in Settings → Voice Templates and
 * flips `active=true` when it looks good. Until then, draft assembly
 * keeps using the global template.
 *
 * Scoped to the caller's own repId — a sales rep can trigger this
 * for themselves, admin can pass a {rep_id} param to build for anyone.
 * No per-rep DAILY cap beyond the LLM cost concern; each template
 * build is ~1 LLM call.
 */
async function doBuildRepTemplate(
  session: { repId: number; role: string; repName?: string },
  params: Record<string, unknown>,
): Promise<{ ok: boolean; detail: Record<string, unknown> }> {
  const isAdmin = session.role === "admin";
  const targetRepId = typeof params.rep_id === "number" && isAdmin
    ? params.rep_id
    : session.repId;

  // Look up the target rep's name (used both as the template key and
  // inside the LLM prompt so it can ground on "who's writing this").
  const { data: rep } = await supabase
    .from("sales_reps")
    .select("id, name, sender_name")
    .eq("id", targetRepId)
    .maybeSingle();
  if (!rep) return { ok: false, detail: { error: "Rep not found" } };

  // Grab the 10 most recent SENT leads with heavy edits. Draft-original
  // is the AI's output; draft-html is what the rep actually sent. The
  // diff between them is the rep's voice, in aggregate.
  const HEAVY_EDIT_THRESHOLD = 200;
  const { data: samples, error: samplesErr } = await supabase
    .from("pipeline_leads")
    .select("id, title, draft_original_html, draft_html, edit_reasons, edit_note, draft_edit_distance")
    .eq("assigned_rep_id", targetRepId)
    .eq("status", "sent")
    .gt("draft_edit_distance", HEAVY_EDIT_THRESHOLD)
    .not("draft_original_html", "is", null)
    .not("draft_html", "is", null)
    .order("sent_at", { ascending: false })
    .limit(10);
  if (samplesErr) {
    // Common cause: migration 008 not applied → draft_original_html /
    // draft_edit_distance columns don't exist yet. Surface a precise
    // error so admin knows to run the migration, instead of a raw
    // Postgres message that reads as a general system failure.
    const msg = samplesErr.message || "";
    const missingColumn = /column .* does not exist/i.test(msg) || /no such column/i.test(msg);
    return {
      ok: false,
      detail: {
        error: missingColumn
          ? "Voice capture needs migration 008 (draft edit-tracking columns). Run migrations/008-drift-and-edit-tracking.sql in Supabase SQL Editor, then retry."
          : msg,
      },
    };
  }
  if (!samples || samples.length < 3) {
    return {
      ok: false,
      detail: {
        error: `Not enough heavy-edit samples (${samples?.length ?? 0}/3 min). Need 3+ edits with draft_edit_distance > ${HEAVY_EDIT_THRESHOLD}.`,
      },
    };
  }

  // Load the global template — we're diffing against it, so the LLM
  // sees "here's the baseline, here's the rep's edits, produce the
  // rep-specific variants of each part."
  const { data: globalTpl } = await supabase
    .from("email_templates")
    .select("*")
    .eq("name", "global")
    .maybeSingle();
  if (!globalTpl) {
    return { ok: false, detail: { error: "Global template missing — migration 011 not run?" } };
  }

  const stripHtml = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const diffPairs = samples.map((s, i) => {
    const ai = stripHtml((s.draft_original_html as string) ?? "").slice(0, 800);
    const final = stripHtml((s.draft_html as string) ?? "").slice(0, 800);
    const reasons = Array.isArray(s.edit_reasons) ? (s.edit_reasons as string[]).join(", ") : "";
    const note = (s.edit_note as string | null) ?? "";
    return `### Sample ${i + 1}${reasons ? ` (reasons: ${reasons})` : ""}${note ? ` (rep note: ${note})` : ""}
AI wrote:
${ai}

Rep sent:
${final}`;
  }).join("\n\n");

  const system = `You are analyzing a sales rep's editing style to produce a per-rep email template.

You will see the baseline "global" email template (what the AI currently generates) and several examples of this rep's edits (AI draft → what the rep actually sent). Infer the rep's voice: what do they consistently change, delete, or rephrase? Produce a new version of each template part in the rep's voice.

Rules:
- Return ONLY valid JSON, no prose before or after.
- Keep ALL placeholder tokens (like {{title}}, {{rep_name}}, {{closing_name}}, {{rep_wechat}}, {{first_name_or_you}}, {{school_text}}, {{base_info}}, {{directions_text}}, {{wechat_article_url}}, {{apply_url}}) exactly as they appear — don't rename them, don't add new ones.
- The new template must still be a valid email: greeting → personalized intro → rep intro → school pitch → CTA/signoff.
- Chinese for body, English OK for subject prefix.
- Match the rep's voice, not a fictional "better" voice. If the rep is terse, be terse. If they're warm, be warm.
- If you can't see a clear pattern (e.g. edits are random), say so via a high-level "notes" field and return the global template's fields unchanged.`;

  const user = `## Baseline (global template)

subject_format: ${globalTpl.subject_format}
intro_prompt: (too long to include; same across reps)
greeting_format: ${globalTpl.greeting_format}
rep_intro_format: ${globalTpl.rep_intro_format}
school_pitch_format: ${globalTpl.school_pitch_format}
cta_signoff_format: ${globalTpl.cta_signoff_format}

## Rep: ${rep.sender_name ?? rep.name}

## Samples (AI → what rep sent)

${diffPairs}

## Your task

Return JSON with these exact keys:
{
  "subject_format": "...",
  "greeting_format": "...",
  "rep_intro_format": "...",
  "school_pitch_format": "...",
  "cta_signoff_format": "...",
  "notes": "1-2 sentence summary of what you changed and why"
}

The intro_prompt stays the same as global — we're not changing how the LLM writes the personalized sentence, just how the email around it is shaped.`;

  let llmJson: Record<string, unknown>;
  try {
    const r = await llmChat({
      model: "gemini-3-pro",
      system,
      user,
      temperature: 0.3,
      max_tokens: 2000,
      timeoutMs: 60_000,
    });
    const text = r.text.trim().replace(/^```json\s*/, "").replace(/\s*```$/, "");
    llmJson = JSON.parse(text);
  } catch (err) {
    return { ok: false, detail: { error: `LLM or JSON parse failed: ${err instanceof Error ? err.message : String(err)}` } };
  }

  // Validate the required fields exist. If any are missing we'd be
  // inserting a half-formed template; safer to bail so admin sees the
  // error.
  const required = ["subject_format", "greeting_format", "rep_intro_format", "school_pitch_format", "cta_signoff_format"];
  for (const k of required) {
    if (typeof llmJson[k] !== "string" || (llmJson[k] as string).trim().length === 0) {
      return { ok: false, detail: { error: `LLM output missing or empty field: ${k}`, raw: llmJson } };
    }
  }

  // Name the template. Sanitize rep name → snake case for stability.
  const nameKey = `rep_${(rep.name as string).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;

  // Insert as INACTIVE. Admin flips active=true in Settings. If a row
  // with this name already exists, we UPDATE (assumption: rerunning
  // means "regenerate, the old one was stale") but keep it inactive.
  const { data: inserted, error: insErr } = await supabase
    .from("email_templates")
    .upsert({
      name: nameKey,
      rep_id: targetRepId,
      active: false,
      subject_format: llmJson.subject_format as string,
      intro_prompt: globalTpl.intro_prompt,  // reuse global
      greeting_format: llmJson.greeting_format as string,
      rep_intro_format: llmJson.rep_intro_format as string,
      school_pitch_format: llmJson.school_pitch_format as string,
      cta_signoff_format: llmJson.cta_signoff_format as string,
      notes: `Auto-generated from ${samples.length} heavy-edit samples on ${new Date().toISOString().slice(0, 10)}. ${typeof llmJson.notes === "string" ? llmJson.notes : ""}`,
      updated_at: new Date().toISOString(),
    }, { onConflict: "name" })
    .select()
    .single();
  if (insErr) return { ok: false, detail: { error: insErr.message } };

  return {
    ok: true,
    detail: {
      template_id: inserted.id,
      template_name: nameKey,
      samples_used: samples.length,
      active: false,
      notes: typeof llmJson.notes === "string" ? llmJson.notes : null,
      next_step: "Admin reviews in Settings → Voice Templates and activates.",
    },
  };
}

export async function POST(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const conversationId = typeof body.conversationId === "string" ? body.conversationId : null;
  const proposal = isObject(body.proposal) ? body.proposal : null;
  if (!proposal || typeof proposal.action !== "string") {
    return NextResponse.json({ error: "proposal.action required" }, { status: 400 });
  }

  // Conversation ownership check (if provided).
  if (conversationId) {
    const { data: conv } = await supabase
      .from("helper_conversations")
      .select("rep_id")
      .eq("id", conversationId)
      .maybeSingle();
    if (!conv || (session.role !== "admin" && conv.rep_id !== session.repId)) {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }
  }

  // Reconstruct the request origin + forward cookie so downstream
  // routes see the same session.
  const origin = new URL(req.url).origin;
  const cookie = req.headers.get("cookie") ?? "";

  let result: { ok: boolean; detail: Record<string, unknown> };
  try {
    switch (proposal.action) {
      case "batch_send":
        result = await doBatchSend(session, proposal, origin, cookie);
        break;
      case "skip_lead":
        result = await doSkip(session, proposal, origin, cookie);
        break;
      case "flag_lead":
        result = await doFlag(session, proposal, origin, cookie);
        break;
      case "bulk_flag":
        result = await doBulkFlag(session, proposal, origin, cookie);
        break;
      case "redraft_lead":
        result = await doRedraft(session, proposal, origin, cookie);
        break;
      case "review_next":
        result = await doReviewNext();
        break;
      case "build_rep_template":
        result = await doBuildRepTemplate(session, proposal);
        break;
      case "open_split_view":
        result = await doOpenSplitView(session, proposal);
        break;
      case "remember_about_rep":
        result = await doRememberAboutRep(session, proposal);
        break;
      case "track_prediction":
        result = await doTrackPrediction(session, proposal);
        break;
      case "reassign_lead":
        result = await doReassignLead(session, proposal);
        break;
      case "reassign_leads_bulk":
        result = await doReassignLeadsBulk(session, proposal);
        break;
      case "learn_from_admin_correction":
        result = await doLearnFromAdminCorrection(session, proposal);
        break;
      case "recall_my_mistakes":
        result = await doRecallMyMistakes(session, proposal);
        break;
      default:
        result = { ok: false, detail: { error: `Unknown action: ${proposal.action}` } };
    }
  } catch (e) {
    // Log the raw error server-side for debugging, but don't ship it
    // to the client — Postgres stack hints / schema names leak when
    // we echo e.message back. Generic string, correlated via the
    // conversation log which captures the real detail.
    console.error("/api/help/execute action crashed", { action: proposal.action, err: e });
    result = { ok: false, detail: { error: "Action failed — check server logs or try again." } };
  }

  await logToolMessage(conversationId, proposal, result);

  return NextResponse.json(result);
}
