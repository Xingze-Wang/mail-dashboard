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
  const filter = typeof params.filter === "string" ? params.filter : "all";
  const limit = Math.max(1, Math.min(HARD_CAP, Math.floor(Number(params.limit) || 10)));

  // Pick ids: rep's ready leads, most recent first. Apply filter if specified.
  let q = supabase
    .from("pipeline_leads")
    .select("id, lead_tier")
    .eq("status", "ready")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (session.role !== "admin") q = q.eq("assigned_rep_id", session.repId);
  if (filter === "strong") q = q.eq("lead_tier", "strong");
  else if (filter === "normal") q = q.eq("lead_tier", "normal");

  const { data: leads, error } = await q;
  if (error || !leads || leads.length === 0) {
    return { ok: false, detail: { error: error?.message ?? "No matching leads" } };
  }

  const ids = leads.map((l) => l.id);

  // Forward to batch-send via a direct internal fetch so all the
  // existing guards (auth, ownership, override quota, contact-guard)
  // run exactly once. Note: we pass the caller's cookie through so
  // batch-send sees the same session.
  const res = await fetch(`${reqOrigin}/api/pipeline/batch-send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    // IMPORTANT: we don't pass `overrides` here — if sales wants an
    // override-heavy batch, they need to go through the Bulk UI (which
    // surfaces the 200/day cap). The helper is for normal sends; if
    // all leads are <7d old, batch-send will skip them and return a
    // breakdown in `blocks.age_gate` that we surface below.
    body: JSON.stringify({ ids }),
  });
  const detail = await res.json().catch(() => ({}));
  return { ok: res.ok, detail };
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
      default:
        result = { ok: false, detail: { error: `Unknown action: ${proposal.action}` } };
    }
  } catch (e) {
    result = { ok: false, detail: { error: e instanceof Error ? e.message : String(e) } };
  }

  await logToolMessage(conversationId, proposal, result);

  return NextResponse.json(result);
}
