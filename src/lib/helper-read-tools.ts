/**
 * Server-side read-tool runner for the Sales Helper.
 *
 * These are called inside /api/help/ask after the LLM returns a
 * response containing one or more ```lookup {...}``` blocks. The
 * results get fed back into the LLM as part of a 2nd-pass prompt,
 * so the LLM can produce a grounded answer.
 *
 * Read tools DON'T mutate anything — they just narrow the data
 * the LLM sees. So we can auto-run without user confirmation.
 *
 * Scoping: every tool respects `session.repId` for non-admin
 * callers. An admin can pass `repId` in args to inspect a specific
 * rep's data.
 */

import { supabase } from "@/lib/db";
import { DAILY_OVERRIDE_CAP, countOverridesTodayByRep } from "@/lib/override-quota";
import { CONTACTED_LEAD_STATUSES } from "@/lib/status";
import { computeGrowth } from "@/lib/rep-growth";
import { loadActiveLearnings } from "@/lib/helper-learnings";
import { getAdminAlerts } from "@/lib/admin-alerts";
import type { ToolCall } from "@/lib/helper-tools";

type Session = { repId: number; role: string; repName?: string; email?: string };

function scopeRepId(session: Session, args: Record<string, unknown>): number | null {
  if (session.role === "admin") {
    const r = Number(args.repId);
    return Number.isFinite(r) ? r : null;
  }
  return session.repId;
}

async function listLeads(session: Session, args: Record<string, unknown>) {
  const status = typeof args.status === "string" ? args.status : null;
  const query = typeof args.query === "string" ? args.query.trim() : null;
  const limit = Math.max(1, Math.min(20, Number(args.limit) || 10));

  let q = supabase
    .from("pipeline_leads")
    .select("id, title, author_name, author_email, lead_tier, status, created_at, published_at, assigned_rep_id")
    .order("created_at", { ascending: false })
    .limit(limit);

  const r = scopeRepId(session, args);
  if (r !== null) q = q.eq("assigned_rep_id", r);
  if (status) q = q.eq("status", status);

  if (query) {
    if (/[,()]/.test(query)) return { error: "query contains invalid characters" };
    q = q.or(`title.ilike.%${query}%,author_name.ilike.%${query}%,author_email.ilike.%${query}%`);
  }

  const { data, error } = await q;
  if (error) return { error: error.message };
  return {
    leads: (data ?? []).map((l) => ({
      id: l.id,
      title: l.title,
      author_name: l.author_name,
      author_email: l.author_email,
      lead_tier: l.lead_tier,
      status: l.status,
      created_at: l.created_at,
      published_at: l.published_at,
      assigned_rep_id: l.assigned_rep_id,
    })),
  };
}

async function getLead(session: Session, args: Record<string, unknown>) {
  const leadId = typeof args.lead_id === "string" ? args.lead_id : null;
  if (!leadId) return { error: "lead_id required" };
  const { data, error } = await supabase
    .from("pipeline_leads")
    .select("*")
    .eq("id", leadId)
    .maybeSingle();
  if (error) return { error: error.message };
  if (!data) return { error: "Lead not found" };
  if (session.role !== "admin" && data.assigned_rep_id !== session.repId) {
    return { error: "Lead not found" };
  }
  const { draft_html: _html, ...rest } = data;
  return { lead: rest };
}

async function getMyStats(session: Session) {
  const repId = session.repId;
  // Kept in sync with /api/metrics/me via CONTACTED_LEAD_STATUSES in
  // @/lib/status, so the helper's answers match what the rep sees on
  // the overview page. `wechat` is attributed via
  // brief_lookups.marked_by_rep_id — the rep who clicked "Added on
  // WeChat", not the lead's owner. Pre-migration-012 rows
  // (marked_by_rep_id=null) are excluded because their attribution
  // is genuinely unknown.
  const [
    { count: assigned },
    { count: ready },
    { count: sent },
    { count: replied },
    { data: wechatRows },
  ] = await Promise.all([
    supabase.from("pipeline_leads").select("*", { count: "exact", head: true }).eq("assigned_rep_id", repId),
    supabase.from("pipeline_leads").select("*", { count: "exact", head: true }).eq("assigned_rep_id", repId).eq("status", "ready"),
    supabase.from("pipeline_leads").select("*", { count: "exact", head: true }).eq("assigned_rep_id", repId).in("status", [...CONTACTED_LEAD_STATUSES]),
    supabase.from("pipeline_leads").select("*", { count: "exact", head: true }).eq("assigned_rep_id", repId).eq("status", "replied"),
    supabase.from("brief_lookups").select("lead_id").eq("added_wechat", true).eq("marked_by_rep_id", repId).not("lead_id", "is", null),
  ]);
  const sentCount = sent ?? 0;
  const wechatDistinct = new Set<string>();
  for (const r of wechatRows ?? []) {
    const id = (r as { lead_id: string | null }).lead_id;
    if (id) wechatDistinct.add(id);
  }
  const wechat = wechatDistinct.size;
  const overrideUsed = (await countOverridesTodayByRep(repId)) ?? 0;
  return {
    stats: {
      assigned: assigned ?? 0,
      ready: ready ?? 0,
      sent: sentCount,
      replied: replied ?? 0,
      wechat,
      override_used_today: overrideUsed,
      override_cap: DAILY_OVERRIDE_CAP,
      override_remaining: Math.max(0, DAILY_OVERRIDE_CAP - overrideUsed),
    },
  };
}

function getRepInfo(session: Session) {
  return {
    rep: {
      id: session.repId,
      name: session.repName ?? null,
      email: session.email ?? null,
      role: session.role,
    },
  };
}

async function getMyGrowth(session: Session, args: Record<string, unknown>) {
  // Admin can inspect a specific rep with repId arg.
  const target = scopeRepId(session, args) ?? session.repId;
  const snap = await computeGrowth(target);
  return { growth: snap };
}

async function getMyMemory(session: Session, args: Record<string, unknown>) {
  // What does the helper know about this rep across past sessions?
  // Returns active (non-superseded) learnings tagged for this rep + org-wide.
  const target = scopeRepId(session, args) ?? session.repId;
  const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));
  const learnings = await loadActiveLearnings(target, limit);
  return {
    memory: learnings.map((l) => ({
      id: l.id,
      kind: l.kind,
      body: l.body,
      scope: l.scope_rep_id == null ? "org" : "rep",
      confidence: l.confidence,
      created_at: l.created_at,
    })),
  };
}

/**
 * Run a single read-tool call. Returns { tool, result }.
 * Never throws — errors go in the result payload.
 */
export async function runReadTool(
  session: Session,
  call: ToolCall,
): Promise<{ tool: string; result: Record<string, unknown> }> {
  const args = call.args ?? {};
  try {
    switch (call.tool) {
      case "list_leads":
        return { tool: call.tool, result: await listLeads(session, args) };
      case "get_lead":
        return { tool: call.tool, result: await getLead(session, args) };
      case "get_my_stats":
        return { tool: call.tool, result: await getMyStats(session) };
      case "get_rep_info":
        return { tool: call.tool, result: getRepInfo(session) };
      case "get_my_growth":
        return { tool: call.tool, result: await getMyGrowth(session, args) };
      case "get_my_memory":
        return { tool: call.tool, result: await getMyMemory(session, args) };
      case "get_admin_alerts":
        if (session.role !== "admin") {
          return { tool: call.tool, result: { error: "admin only" } };
        }
        return { tool: call.tool, result: await getAdminAlerts() };
      default:
        return { tool: call.tool, result: { error: `unknown tool: ${call.tool}` } };
    }
  } catch (e) {
    return { tool: call.tool, result: { error: e instanceof Error ? e.message : String(e) } };
  }
}

/** Extract all ```lookup {json}``` blocks from an LLM response. */
export function extractReadToolCalls(text: string): ToolCall[] {
  const out: ToolCall[] = [];
  const re = /```lookup\s*\n([\s\S]*?)\n```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      if (parsed && typeof parsed === "object" && typeof parsed.tool === "string") {
        out.push({ tool: parsed.tool, args: (parsed.args ?? {}) as Record<string, unknown> });
      }
    } catch {
      /* skip */
    }
  }
  return out;
}

/** Strip all lookup blocks from text (for clean display). */
export function stripReadToolCalls(text: string): string {
  return text.replace(/```lookup\s*\n[\s\S]*?\n```/g, "").trim();
}
