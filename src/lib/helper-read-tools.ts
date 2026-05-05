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
import { getStaleWechatFollowups } from "@/lib/wechat-followup";
import { runIntegrity } from "@/lib/integrity";
import { diagnoseMetricDrop, type DiagnoseMetric } from "@/lib/diagnose-metric";
import type { ToolCall } from "@/lib/helper-tools";

type Session = { repId: number; role: string; repName?: string; email?: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

async function getMyWeeklyRecap(session: Session) {
  // 7-day rep-scoped recap. Used by the helper opener on Monday to
  // lead with "上周你 send 了 X 封, Y 个 click 了, Z 加了微信..."
  // Source priority:
  //   - sent count: emails table filtered to this rep's sender_email
  //     (consistent with /api/emails per-rep scoping)
  //   - clicks: email_history.was_clicked (Tier 2 view — counts
  //     ever-clicked even if the row later moved to complained)
  //   - wechat: brief_lookups.marked_by_rep_id (actor, not owner)
  //   - top performer: lead_id with the most webhook click events
  //     among this rep's last-7d sends; tie-break by recency.
  const repId = session.repId;
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();

  // Resolve this rep's sender_email — same scoping as /api/emails.
  const { data: rep } = await supabase
    .from("sales_reps")
    .select("sender_email")
    .eq("id", repId)
    .maybeSingle();
  const senderEmail = rep?.sender_email as string | null;
  if (!senderEmail) {
    return {
      windowDays: 7,
      sent: 0,
      clicked: 0,
      wechat: 0,
      topPerformer: null,
      note: "rep has no sender_email configured — recap unavailable",
    };
  }

  const fromIlike = `%${senderEmail}%`;

  const [{ count: sent }, { count: clicked }, { data: wechatRows }] = await Promise.all([
    supabase
      .from("emails")
      .select("*", { count: "exact", head: true })
      .ilike("from", fromIlike)
      .gte("created_at", since),
    // email_history is the Tier-2 ever-happened view; was_clicked stays
    // true even if the email later complained.
    supabase
      .from("email_history")
      .select("*", { count: "exact", head: true })
      .ilike("from_address", fromIlike)
      .gte("created_at", since)
      .eq("was_clicked", true),
    supabase
      .from("brief_lookups")
      .select("lead_id, query, wechat_at")
      .eq("added_wechat", true)
      .eq("marked_by_rep_id", repId)
      .gte("wechat_at", since),
  ]);

  const wechatDistinct = new Set<string>();
  for (const r of wechatRows ?? []) {
    const id = (r as { lead_id: string | null }).lead_id;
    if (id) wechatDistinct.add(id);
  }
  const wechat = wechatDistinct.size;

  // Top performer: among rep's wechat conversions this week, the lead
  // whose first wechat mark is most recent (i.e., the freshest win to
  // talk about). Cheap proxy — we don't try to score "best" lead.
  let topPerformer: { lead_id: string; title: string | null; recipient: string | null; wechat_at: string } | null = null;
  if ((wechatRows ?? []).length > 0) {
    const sorted = [...(wechatRows ?? [])].sort((a, b) => {
      const at = (a.wechat_at as string) ?? "";
      const bt = (b.wechat_at as string) ?? "";
      return bt.localeCompare(at);
    });
    const top = sorted[0];
    if (top?.lead_id) {
      const { data: lead } = await supabase
        .from("pipeline_leads")
        .select("id, title")
        .eq("id", top.lead_id)
        .maybeSingle();
      topPerformer = {
        lead_id: top.lead_id as string,
        title: lead?.title ?? null,
        recipient: (top as { query?: string | null }).query ?? null,
        wechat_at: top.wechat_at as string,
      };
    }
  }

  return {
    windowDays: 7,
    sent: sent ?? 0,
    clicked: clicked ?? 0,
    wechat,
    clickRate: (sent ?? 0) > 0 ? Number(((clicked ?? 0) / (sent ?? 1)).toFixed(3)) : 0,
    wechatRate: (clicked ?? 0) > 0 ? Number((wechat / (clicked ?? 1)).toFixed(3)) : 0,
    topPerformer,
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

async function listReps() {
  // List of all sales reps so the helper can translate a rep name
  // ("Chenyu") to a rep_id (2). Used primarily when admin wants to
  // re-assign a lead but speaks the rep's name. Doesn't expose
  // anything sensitive — name + role are already in the sidebar UI
  // for everyone in the org.
  const { data, error } = await supabase
    .from("sales_reps")
    .select("id, name, sender_name, role, active")
    .order("id", { ascending: true });
  if (error) return { error: error.message };
  return {
    reps: (data ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      sender_name: r.sender_name ?? null,
      role: r.role,
      active: r.active !== false,
    })),
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
      case "list_reps":
        return { tool: call.tool, result: await listReps() };
      case "get_my_growth":
        return { tool: call.tool, result: await getMyGrowth(session, args) };
      case "get_my_weekly_recap":
        return { tool: call.tool, result: await getMyWeeklyRecap(session) };
      case "get_my_memory":
        return { tool: call.tool, result: await getMyMemory(session, args) };
      case "get_admin_alerts":
        if (session.role !== "admin") {
          return { tool: call.tool, result: { error: "admin only" } };
        }
        return { tool: call.tool, result: await getAdminAlerts() };
      case "get_wechat_followups": {
        // Sales sees only their own stale wechat marks. Admin can pass
        // repId in args to inspect a rep, or omit for org-wide.
        const target = scopeRepId(session, args);
        const stale = await getStaleWechatFollowups(target);
        return { tool: call.tool, result: { stale } };
      }
      case "get_integrity_report": {
        if (session.role !== "admin") {
          return { tool: call.tool, result: { error: "admin only" } };
        }
        // Tier 6 of docs/DATA_INTEGRITY_PLAN.md. Same checks as
        // /api/integrity. Helper opener uses this so admin sees red
        // invariants without having to navigate anywhere.
        const report = await runIntegrity();
        return { tool: call.tool, result: { ...report } as unknown as Record<string, unknown> };
      }
      case "find_similar_leads": {
        // Dream #9 — cosine NN search in the embedding column.
        // Stays useful only after migration 030 lands AND
        // backfill-embeddings has run. Until then returns a clean
        // hint so the helper can degrade gracefully.
        const refId = String(args.reference_lead_id ?? "");
        if (!UUID_RE.test(refId) && !/^[\w-]+$/.test(refId)) {
          return { tool: call.tool, result: { error: "reference_lead_id required" } };
        }
        const limit = Math.max(1, Math.min(20, Number(args.n) || 5));
        const { data: ref, error: refErr } = await supabase
          .from("pipeline_leads")
          .select("id, embedding")
          .eq("id", refId)
          .maybeSingle();
        if (refErr) return { tool: call.tool, result: { error: refErr.message } };
        if (!ref) return { tool: call.tool, result: { error: "reference lead not found" } };
        if (!(ref as { embedding?: unknown }).embedding) {
          return {
            tool: call.tool,
            result: {
              error: "reference lead has no embedding yet — run scripts/backfill-embeddings.mjs (or pgvector extension may not be enabled in Supabase dashboard)",
            },
          };
        }
        // pgvector cosine distance via SQL — postgrest can't express
        // <-> operator natively, so use the rpc helper. Falls through
        // gracefully if rpc missing.
        const { data: similar, error: simErr } = await supabase.rpc("find_similar_leads_by_embedding", {
          ref_id: refId,
          k: limit,
        });
        if (simErr) {
          return { tool: call.tool, result: { error: `rpc failed (helper RPC may need to be defined): ${simErr.message}` } };
        }
        return { tool: call.tool, result: { reference_lead_id: refId, similar: similar ?? [] } };
      }
      case "diagnose_metric_drop": {
        const allowed: DiagnoseMetric[] = ["click_rate", "wechat_rate"];
        const metric = String(args.metric ?? "");
        if (!allowed.includes(metric as DiagnoseMetric)) {
          return { tool: call.tool, result: { error: `metric must be one of ${allowed.join("|")}` } };
        }
        const days = Math.max(7, Math.min(60, Number(args.days) || 7));
        const target = scopeRepId(session, args);
        const result = await diagnoseMetricDrop({
          metric: metric as DiagnoseMetric,
          repId: target,
          days,
        });
        return { tool: call.tool, result: { ...result } as unknown as Record<string, unknown> };
      }
      case "get_rep_helper_activity": {
        if (session.role !== "admin") {
          return { tool: call.tool, result: { error: "admin only" } };
        }
        // Admin spot-check: what is rep N actually asking the helper
        // about lately? Returns up to N recent user messages from a
        // single rep. Cluster detection (shared_helper_questions) is
        // statistical; this is qualitative — useful when admin wants
        // to know "what's Chenyu stuck on?" before the cluster floor
        // (≥2 reps) is met.
        const target = scopeRepId(session, args);
        if (target == null) {
          return { tool: call.tool, result: { error: "repId required" } };
        }
        const limit = Math.max(1, Math.min(20, Number(args.limit) || 10));
        const days = Math.max(1, Math.min(60, Number(args.days) || 14));
        const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
        const { data, error } = await supabase
          .from("helper_messages")
          .select("text, created_at, conversation_id, helper_conversations!inner(rep_id)")
          .eq("role", "user")
          .eq("helper_conversations.rep_id", target)
          .gte("created_at", cutoff)
          .order("created_at", { ascending: false })
          .limit(limit);
        if (error) return { tool: call.tool, result: { error: error.message } };
        return {
          tool: call.tool,
          result: {
            repId: target,
            windowDays: days,
            messages: (data ?? []).map((m) => ({
              text: String(m.text ?? "").slice(0, 400),
              createdAt: m.created_at,
              conversationId: m.conversation_id,
            })),
          },
        };
      }
      case "dm_user": {
        // Send a Lark text DM to a user by open_id. Side-effect tool —
        // listed under "lookup" so the lark-agent loop can fire it
        // immediately. The user is in DM with the bot; they see what was
        // sent and can correct course.
        const { sendMessage } = await import("@/lib/lark");
        const openId = String(args.open_id ?? "").trim();
        const text = String(args.text ?? "").trim();
        if (!/^ou_[A-Za-z0-9]+$/.test(openId)) {
          return { tool: call.tool, result: { error: "open_id must look like ou_xxx" } };
        }
        if (!text) return { tool: call.tool, result: { error: "text required" } };
        if (text.length > 4000) return { tool: call.tool, result: { error: "text too long (>4000 chars)" } };
        const r = await sendMessage({ receive_id: openId, receive_id_type: "open_id", text });
        return { tool: call.tool, result: r as unknown as Record<string, unknown> };
      }
      case "dm_chat": {
        // Send a Lark text message to a chat by chat_id (group OR p2p).
        const { sendMessage } = await import("@/lib/lark");
        const chatId = String(args.chat_id ?? "").trim();
        const text = String(args.text ?? "").trim();
        if (!/^oc_[A-Za-z0-9]+$/.test(chatId)) {
          return { tool: call.tool, result: { error: "chat_id must look like oc_xxx" } };
        }
        if (!text) return { tool: call.tool, result: { error: "text required" } };
        if (text.length > 4000) return { tool: call.tool, result: { error: "text too long (>4000 chars)" } };
        const r = await sendMessage({ receive_id: chatId, receive_id_type: "chat_id", text });
        return { tool: call.tool, result: r as unknown as Record<string, unknown> };
      }
      case "create_lark_doc": {
        // Create a docx and (optionally) write a body. Returns the URL.
        const { createLarkDoc } = await import("@/lib/lark");
        const title = String(args.title ?? "").trim();
        const body = typeof args.body === "string" ? args.body : "";
        if (!title) return { tool: call.tool, result: { error: "title required" } };
        if (title.length > 200) return { tool: call.tool, result: { error: "title too long (>200 chars)" } };
        const r = await createLarkDoc({ title, body });
        return { tool: call.tool, result: r as unknown as Record<string, unknown> };
      }
      case "add_to_lark_base": {
        // Append a row to a Lark Base table.
        // args: { app_token, table_id, fields: { ColumnName: value, ... } }
        const { addToLarkBase } = await import("@/lib/lark");
        const appToken = String(args.app_token ?? "").trim();
        const tableId = String(args.table_id ?? "").trim();
        const fields = (args.fields && typeof args.fields === "object")
          ? args.fields as Record<string, unknown>
          : null;
        if (!appToken || !tableId || !fields) {
          return { tool: call.tool, result: { error: "app_token, table_id, fields required" } };
        }
        const r = await addToLarkBase({ app_token: appToken, table_id: tableId, fields });
        return { tool: call.tool, result: r as unknown as Record<string, unknown> };
      }
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
