import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

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

const HARD_CAP = 50; // never execute more than 50 sends in one proposal

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
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

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
      default:
        result = { ok: false, detail: { error: `Unknown action: ${proposal.action}` } };
    }
  } catch (e) {
    result = { ok: false, detail: { error: e instanceof Error ? e.message : String(e) } };
  }

  await logToolMessage(conversationId, proposal, result);

  return NextResponse.json(result);
}
