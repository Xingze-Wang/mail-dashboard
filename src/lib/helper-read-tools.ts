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

type Session = { repId: number; role: string; repName?: string; email?: string; messageId?: string | null };

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
  // ("Yujie", "caohongyuze", "曹鸿宇泽") to a rep_id (2, 3, 3). Used
  // when admin wants to re-assign a lead but speaks the rep's name.
  //
  // aliases (mig 081) covers Lark display names + pinyin + family-name
  // short forms. lark_name is the rep's actual Lark display name in
  // Chinese — kept separate from aliases because it's authoritative
  // (auto-pulled from Lark) rather than admin-curated.
  const { data, error } = await supabase
    .from("sales_reps")
    .select("id, name, sender_name, lark_name, aliases, role, active")
    .order("id", { ascending: true });
  if (error) return { error: error.message };
  return {
    reps: (data ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      sender_name: r.sender_name ?? null,
      lark_name: (r.lark_name as string | null) ?? null,
      aliases: Array.isArray(r.aliases) ? r.aliases as string[] : [],
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
      case "get_admin_daily_report": {
        if (session.role !== "admin") {
          return { tool: call.tool, result: { ok: false, error: "admin only" } };
        }
        try {
          const { buildAdminDailyReport } = await import("@/lib/admin-daily-report");
          const text = await buildAdminDailyReport();
          return { tool: call.tool, result: { ok: true, text } };
        } catch (e) {
          return { tool: call.tool, result: { ok: false, error: e instanceof Error ? e.message : String(e) } };
        }
      }
      case "get_my_missions_today": {
        const { supabase } = await import("@/lib/db");
        const today = new Date().toISOString().slice(0, 10);
        const ms = await supabase
          .from("missions")
          .select("id, kind, target, status, scope")
          .eq("rep_id", session.repId)
          .eq("due_date", today)
          .eq("status", "active");
        if (ms.error) return { tool: call.tool, result: { ok: false, error: ms.error.message } };
        const ids = (ms.data || []).map((m) => m.id as string);
        const progress = new Map<string, number>();
        if (ids.length > 0) {
          const p = await supabase
            .from("mission_progress")
            .select("mission_id, count")
            .in("mission_id", ids);
          for (const row of p.data || []) progress.set(row.mission_id as string, (row.count as number) ?? 0);
        }
        return {
          tool: call.tool,
          result: {
            ok: true,
            missions: (ms.data || []).map((m) => ({
              id: m.id,
              kind: m.kind,
              target: m.target,
              progress: progress.get(m.id as string) ?? 0,
              status: m.status,
              scope: m.scope,
            })),
          },
        };
      }
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
      case "get_my_trust_level": {
        // Returns the rep's training-wheels capabilities. Used when rep
        // asks "why am I limited / when does bulk unlock / why can't I
        // batch send". Read-only; admin escalation handled separately.
        const { getCapabilities } = await import("@/lib/trust-level");
        const caps = await getCapabilities(session.repId);
        // Spread to plain object so it satisfies the dispatcher's
        // Record<string, unknown> result type (RepCapabilities is a
        // typed interface, not an index signature).
        return { tool: call.tool, result: { ...caps } };
      }
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
        // to know "what's Yujie stuck on?" before the cluster floor
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
      case "get_lead_counts": {
        // Total leads + per-rep ownership counts + unassigned pool size.
        // Way cheaper than list_leads when the question is aggregate
        // ("how many cn leads this week", "who owns the most"). Filter
        // by geo / tier / since to scope.
        const sinceArg = typeof args.since_days === "number" ? args.since_days : 7;
        const cutoff = new Date(Date.now() - Math.max(1, Math.min(365, sinceArg)) * 86_400_000).toISOString();
        const geo = typeof args.geo === "string" ? args.geo : null;  // 'cn' | 'edu' | 'overseas'
        const tier = typeof args.lead_tier === "string" ? args.lead_tier : null;  // 'strong' | 'normal'

        // Build a base query — chained .eq / .gte conditionally
        let base = supabase
          .from("pipeline_leads")
          .select("id, assigned_rep_id, lead_tier, author_email", { count: "exact", head: false })
          .gte("created_at", cutoff);
        if (tier) base = base.eq("lead_tier", tier);

        const { data, error, count } = await base;
        if (error) return { tool: call.tool, result: { error: error.message } };
        let rows = (data ?? []) as { id: string; assigned_rep_id: number | null; lead_tier: string | null; author_email: string | null }[];

        // Apply geo filter in-app (author_email domain rules — same as v_lead_pool)
        if (geo) {
          rows = rows.filter((r) => {
            const dom = (r.author_email ?? "").toLowerCase().split("@")[1] ?? "";
            if (geo === "cn") return /\.cn$|\.com\.cn$/i.test(dom);
            if (geo === "edu") return /\.edu$|\.edu\./i.test(dom);
            if (geo === "overseas") return !(/\.cn$|\.com\.cn$|\.edu$|\.edu\./i.test(dom));
            return true;
          });
        }

        // Bucket per rep
        const perRep: Record<string, number> = {};
        let unassigned = 0;
        for (const r of rows) {
          if (r.assigned_rep_id == null) unassigned++;
          else perRep[r.assigned_rep_id] = (perRep[r.assigned_rep_id] ?? 0) + 1;
        }
        // Hydrate rep names
        const repIds = Object.keys(perRep).map(Number);
        const { data: reps } = repIds.length
          ? await supabase.from("sales_reps").select("id, name").in("id", repIds)
          : { data: [] as { id: number; name: string }[] };
        const repName = Object.fromEntries((reps ?? []).map((r) => [r.id, r.name]));

        const perRepArr = Object.entries(perRep)
          .map(([id, c]) => ({ rep_id: Number(id), name: repName[Number(id)] ?? `rep_${id}`, owned_count: c }))
          .sort((a, b) => b.owned_count - a.owned_count);

        return {
          tool: call.tool,
          result: {
            window_days: sinceArg,
            filters: { geo, lead_tier: tier },
            total: geo || tier ? rows.length : count ?? rows.length,
            unassigned,
            per_rep: perRepArr,
          },
        };
      }
      case "get_helper_conversation": {
        // Admin-only: pull BOTH user + assistant turns for a rep's
        // conversation history. Distinct from get_rep_helper_activity
        // which only returns user messages. This is the "what did you
        // say to rep X?" tool — when admin pushes back on an answer,
        // Leon can show the exact prior reply rather than guessing.
        //
        // Returns up to `limit` most-recent turns (default 20), oldest
        // first within the page, so the convo reads top-to-bottom like
        // a real chat log.
        if (session.role !== "admin") {
          return { tool: call.tool, result: { error: "admin only" } };
        }
        const target = scopeRepId(session, args);
        if (target == null) {
          return { tool: call.tool, result: { error: "repId required" } };
        }
        const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));
        const days = Math.max(1, Math.min(60, Number(args.days) || 14));
        const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
        const { data, error } = await supabase
          .from("helper_messages")
          .select("role, text, created_at, conversation_id, helper_conversations!inner(rep_id, mode)")
          .eq("helper_conversations.rep_id", target)
          .in("role", ["user", "assistant"])
          .not("text", "is", null)
          .gte("created_at", cutoff)
          .order("created_at", { ascending: false })
          .limit(limit);
        if (error) return { tool: call.tool, result: { error: error.message } };
        // Reverse so consumer sees chronological order
        const turns = (data ?? []).reverse().map((m) => ({
          role: m.role as string,
          text: String(m.text ?? "").slice(0, 600),
          createdAt: m.created_at,
          conversationId: m.conversation_id,
          surface: (m as { helper_conversations?: { mode?: string } }).helper_conversations?.mode ?? "web",
        }));
        return {
          tool: call.tool,
          result: {
            repId: target,
            windowDays: days,
            turnCount: turns.length,
            turns,
          },
        };
      }
      case "list_admin_escalations": {
        // Admin-only: list recent unresolved admin_inbox kind=request
        // rows that came from Leon's escalate_to_admin tool. Shows the
        // queue of "Leon was unsure → asked you" items so admin can
        // catch up after being away.
        if (session.role !== "admin") {
          return { tool: call.tool, result: { error: "admin only" } };
        }
        const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));
        const status = (args.status as string) || "new";
        let query = supabase
          .from("admin_inbox")
          .select("id, kind, headline, body, source_rep_id, status, evidence, created_at")
          .eq("kind", "request")
          .order("created_at", { ascending: false })
          .limit(limit);
        if (status !== "all") query = query.eq("status", status);
        const { data, error } = await query;
        if (error) return { tool: call.tool, result: { error: error.message } };
        return {
          tool: call.tool,
          result: {
            count: (data ?? []).length,
            escalations: (data ?? []).map((r) => ({
              id: r.id,
              headline: r.headline,
              body: r.body ? String(r.body).slice(0, 300) : null,
              fromRepId: r.source_rep_id,
              status: r.status,
              createdAt: r.created_at,
              // Surface escalation-specific fields out of evidence
              myGuess: (r.evidence as Record<string, unknown> | null)?.my_best_guess ?? null,
              whyUnsure: (r.evidence as Record<string, unknown> | null)?.why_unsure ?? null,
            })),
          },
        };
      }
      case "get_org_helper_activity_today": {
        // Admin spot-check: "who messaged Leon today?" across BOTH
        // surfaces (helper_messages = web bot, lark_messages = Lark DM).
        // Joins to sales_reps so the rep_id↔name mapping is
        // authoritative — previously the agent had no tool for this
        // and would hallucinate names from prompt context (the
        // "rep 5 = 王泽群" bug from 2026-05-15).
        if (session.role !== "admin") {
          return { tool: call.tool, result: { error: "admin only" } };
        }
        const hours = Math.max(1, Math.min(168, Number(args.hours) || 24));
        const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();

        // Helper-messages side. Join to helper_conversations to get rep_id.
        const helperRows = await supabase
          .from("helper_messages")
          .select("text, role, created_at, helper_conversations!inner(rep_id)")
          .eq("role", "user")
          .gte("created_at", cutoff)
          .order("created_at", { ascending: false })
          .limit(200);

        // Lark-messages side. rep_id is already on the row.
        const larkRows = await supabase
          .from("lark_messages")
          .select("text, role, rep_id, chat_id, created_at")
          .eq("role", "user")
          .gte("created_at", cutoff)
          .order("created_at", { ascending: false })
          .limit(200);

        // Unify both into per-rep buckets. group-chat rows have
        // rep_id=null; surface those as "group_chat" so admin sees
        // they exist but knows they're not DMs.
        type Msg = { rep_id: number | null; surface: "web" | "lark"; text: string; createdAt: string };
        const all: Msg[] = [];
        for (const m of helperRows.data ?? []) {
          const c = m.helper_conversations as { rep_id: number | null } | { rep_id: number | null }[] | null;
          const rid = Array.isArray(c) ? c[0]?.rep_id ?? null : c?.rep_id ?? null;
          all.push({ rep_id: rid, surface: "web", text: String(m.text ?? "").slice(0, 300), createdAt: m.created_at as string });
        }
        for (const m of larkRows.data ?? []) {
          all.push({ rep_id: m.rep_id as number | null, surface: "lark", text: String(m.text ?? "").slice(0, 300), createdAt: m.created_at as string });
        }

        // Resolve rep_ids → names in one round trip so we never label
        // a rep_id with a guessed name.
        const repIds = [...new Set(all.map((m) => m.rep_id).filter((x): x is number => x != null))];
        const nameByRepId = new Map<number, string>();
        if (repIds.length > 0) {
          const { data: reps } = await supabase
            .from("sales_reps")
            .select("id, name, sender_name, lark_name, role")
            .in("id", repIds);
          for (const r of reps ?? []) {
            const display = (r.lark_name as string | null) ?? (r.sender_name as string | null) ?? (r.name as string) ?? `rep#${r.id}`;
            nameByRepId.set(r.id as number, `${display} (rep_id=${r.id}, role=${r.role})`);
          }
        }

        // Bucket by rep
        type Bucket = { rep_id: number | null; display: string; surface_breakdown: Record<string, number>; message_count: number; samples: Array<{ surface: string; text: string; at: string }> };
        const buckets = new Map<string, Bucket>();
        for (const m of all) {
          const key = m.rep_id == null ? "unknown_or_group_chat" : String(m.rep_id);
          let b = buckets.get(key);
          if (!b) {
            b = {
              rep_id: m.rep_id,
              display: m.rep_id == null ? "(group-chat or unbound user)" : (nameByRepId.get(m.rep_id) ?? `rep_id=${m.rep_id} (no sales_reps row)`),
              surface_breakdown: {},
              message_count: 0,
              samples: [],
            };
            buckets.set(key, b);
          }
          b.message_count++;
          b.surface_breakdown[m.surface] = (b.surface_breakdown[m.surface] ?? 0) + 1;
          if (b.samples.length < 3) b.samples.push({ surface: m.surface, text: m.text, at: m.createdAt });
        }

        const rows = [...buckets.values()].sort((a, b) => b.message_count - a.message_count);
        return {
          tool: call.tool,
          result: {
            window_hours: hours,
            total_messages: all.length,
            unique_senders: rows.length,
            rows,
          },
        };
      }
      case "dm_user": {
        const { sendMessage } = await import("@/lib/lark");
        const openId = String(args.open_id ?? "").trim();
        const text = String(args.text ?? "").trim();
        if (!/^ou_[A-Za-z0-9]+$/.test(openId)) {
          return { tool: call.tool, result: { error: "open_id must look like ou_xxx" } };
        }
        if (!text) return { tool: call.tool, result: { error: "text required" } };
        if (text.length > 4000) return { tool: call.tool, result: { error: "text too long (>4000 chars)" } };
        const r = await sendMessage({ receive_id: openId, receive_id_type: "open_id", text });
        if (r.ok && r.message_id) {
          await supabase.from("helper_artifacts").insert({
            rep_id: session.repId, kind: "lark_dm",
            lark_id: r.message_id,
            title: text.slice(0, 100),
            url: null, meta: { open_id: openId, length: text.length },
          });
        }
        return { tool: call.tool, result: r as unknown as Record<string, unknown> };
      }
      case "dm_chat": {
        const { sendMessage } = await import("@/lib/lark");
        const chatId = String(args.chat_id ?? "").trim();
        const text = String(args.text ?? "").trim();
        if (!/^oc_[A-Za-z0-9]+$/.test(chatId)) {
          return { tool: call.tool, result: { error: "chat_id must look like oc_xxx" } };
        }
        if (!text) return { tool: call.tool, result: { error: "text required" } };
        if (text.length > 4000) return { tool: call.tool, result: { error: "text too long (>4000 chars)" } };
        const r = await sendMessage({ receive_id: chatId, receive_id_type: "chat_id", text });
        if (r.ok && r.message_id) {
          await supabase.from("helper_artifacts").insert({
            rep_id: session.repId, kind: "lark_chat_msg",
            lark_id: r.message_id,
            title: text.slice(0, 100),
            url: null, meta: { chat_id: chatId, length: text.length },
          });
        }
        return { tool: call.tool, result: r as unknown as Record<string, unknown> };
      }
      case "create_lark_doc": {
        const { createLarkDoc } = await import("@/lib/lark");
        const title = String(args.title ?? "").trim();
        const body = typeof args.body === "string" ? args.body : "";
        if (!title) return { tool: call.tool, result: { error: "title required" } };
        if (title.length > 200) return { tool: call.tool, result: { error: "title too long (>200 chars)" } };
        const r = await createLarkDoc({ title, body });
        if (r.ok && r.document_id && r.url) {
          await supabase.from("helper_artifacts").insert({
            rep_id: session.repId, kind: "lark_doc",
            lark_id: r.document_id,
            title,
            url: r.url, meta: { body_length: body.length },
          });
        }
        return { tool: call.tool, result: r as unknown as Record<string, unknown> };
      }
      case "create_rich_lark_doc": {
        // Rich block-aware doc creator. Pass blocks: [{kind, text}, ...]
        // where kind is h1|h2|h3|h4|paragraph|bullet|numbered|callout|
        // code|quote|divider|todo. Maps each to the right Lark block_type.
        const { createRichLarkDoc } = await import("@/lib/lark");
        const title = String(args.title ?? "").trim();
        const rawBlocks = Array.isArray(args.blocks) ? args.blocks : null;
        if (!title) return { tool: call.tool, result: { error: "title required" } };
        if (title.length > 200) return { tool: call.tool, result: { error: "title too long (>200 chars)" } };
        if (!rawBlocks || rawBlocks.length === 0) return { tool: call.tool, result: { error: "blocks[] required and non-empty" } };
        if (rawBlocks.length > 500) return { tool: call.tool, result: { error: "too many blocks (max 500)" } };
        // Lark API tolerates the union shape; we trust the LLM to emit
        // valid kinds. Server-side validation rejects unknown kinds via
        // buildBlock's exhaustive switch + downstream Lark API error.
        const r = await createRichLarkDoc({ title, blocks: rawBlocks as Parameters<typeof createRichLarkDoc>[0]["blocks"] });
        if (r.ok && r.document_id && r.url) {
          await supabase.from("helper_artifacts").insert({
            rep_id: session.repId,
            kind: "lark_doc",
            lark_id: r.document_id,
            title,
            url: r.url,
            meta: { block_count: r.blocks_written ?? 0, rich: true },
          });
        }
        return { tool: call.tool, result: r as unknown as Record<string, unknown> };
      }
      case "append_to_lark_doc": {
        // Append rich blocks to an existing doc. Use get_my_artifacts
        // first to find the document_id; never invent one.
        const { appendToLarkDoc } = await import("@/lib/lark");
        const documentId = String(args.document_id ?? "").trim();
        const rawBlocks = Array.isArray(args.blocks) ? args.blocks : null;
        if (!documentId) return { tool: call.tool, result: { error: "document_id required (look up via get_my_artifacts)" } };
        if (!rawBlocks || rawBlocks.length === 0) return { tool: call.tool, result: { error: "blocks[] required and non-empty" } };
        if (rawBlocks.length > 500) return { tool: call.tool, result: { error: "too many blocks (max 500)" } };
        const r = await appendToLarkDoc({ document_id: documentId, blocks: rawBlocks as Parameters<typeof appendToLarkDoc>[0]["blocks"] });
        return { tool: call.tool, result: r as unknown as Record<string, unknown> };
      }
      case "list_lark_doc_blocks": {
        // Read every block in a doc with its block_id, type, and text.
        // Required before propose_doc_edit so the agent can target
        // specific blocks by id instead of regenerating the whole doc.
        const { listLarkDocBlocks } = await import("@/lib/lark");
        const documentId = String(args.document_id ?? "").trim();
        if (!documentId) return { tool: call.tool, result: { error: "document_id required" } };
        const r = await listLarkDocBlocks({ document_id: documentId });
        if (!r.ok) return { tool: call.tool, result: { error: r.error ?? "list failed" } };
        // Slim down the response — drop the raw payload by default (LLM
        // doesn't need it for editing decisions). Caller can request
        // include_raw:true for the rare case of complex block inspection.
        const includeRaw = args.include_raw === true;
        const slim = (r.blocks ?? []).map((b) => includeRaw
          ? b
          : { block_id: b.block_id, block_type: b.block_type, parent_id: b.parent_id, text: b.text });
        return { tool: call.tool, result: { ok: true, document_id: documentId, blocks: slim, count: slim.length } };
      }
      case "propose_doc_edit": {
        // Queue a structured edit proposal for admin approval. Each
        // edit is a typed step: update/delete/insert_at/append.
        const { proposeDocEdit } = await import("@/lib/doc-edit-proposals");
        const documentId = String(args.document_id ?? "").trim();
        const documentUrl = String(args.document_url ?? "").trim();
        const summary = String(args.summary ?? "").trim();
        const narration = typeof args.narration === "string" ? args.narration : null;
        const documentTitle = typeof args.document_title === "string" ? args.document_title : null;
        const rawEdits = Array.isArray(args.edits) ? args.edits : null;
        if (!documentId) return { tool: call.tool, result: { error: "document_id required (look up via list_lark_doc_blocks or get_my_artifacts)" } };
        if (!documentUrl) return { tool: call.tool, result: { error: "document_url required (the https://...feishu.cn/docx/<id> link)" } };
        if (!summary || summary.length < 5) return { tool: call.tool, result: { error: "summary required (≥5 chars, ≤300)" } };
        if (!rawEdits || rawEdits.length === 0) return { tool: call.tool, result: { error: "edits[] required and non-empty" } };
        const r = await proposeDocEdit({
          document_id: documentId,
          document_url: documentUrl,
          document_title: documentTitle,
          summary,
          edits: rawEdits as Parameters<typeof proposeDocEdit>[0]["edits"],
          narration,
          proposed_by_rep_id: session.repId,
        });
        return { tool: call.tool, result: r as unknown as Record<string, unknown> };
      }
      case "approve_doc_edit": {
        // Admin-only. Approves a pending proposal and applies it
        // immediately by default. Mirrors the dashboard approve button.
        if (session.role !== "admin") {
          return { tool: call.tool, result: { error: "admin only — sales can't approve their own doc edits" } };
        }
        const { approveDocEditProposal } = await import("@/lib/doc-edit-proposals");
        const proposalId = String(args.proposal_id ?? "").trim();
        if (!proposalId) return { tool: call.tool, result: { error: "proposal_id required" } };
        const applyNow = args.apply_now !== false;     // default true
        const r = await approveDocEditProposal({
          proposal_id: proposalId,
          decided_by_rep_id: session.repId,
          decision_note: typeof args.note === "string" ? args.note : null,
          apply_now: applyNow,
        });
        return { tool: call.tool, result: r as unknown as Record<string, unknown> };
      }
      case "list_doc_edit_proposals": {
        // Admin-only. List pending (or specified-status) proposals so
        // admin can review what Leon wants to do to which docs.
        if (session.role !== "admin") {
          return { tool: call.tool, result: { error: "admin only" } };
        }
        const status = ["pending", "approved", "rejected", "applied", "dismissed"].includes(String(args.status ?? ""))
          ? String(args.status)
          : "pending";
        const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));
        const { data, error } = await supabase
          .from("doc_edit_proposals")
          .select("id, document_id, document_url, document_title, summary, narration, edits, status, applied_at, apply_error, created_at, proposed_by_rep_id")
          .eq("status", status)
          .order("created_at", { ascending: false })
          .limit(limit);
        if (error) return { tool: call.tool, result: { error: error.message } };
        return { tool: call.tool, result: { ok: true, status, count: (data ?? []).length, proposals: data ?? [] } };
      }
      case "propose_db_write": {
        // Leon proposes a DB write (INSERT/UPDATE/DELETE). Inserts a
        // pending row in dynamic_writes + pushes Lark Yes/No card to
        // admin. On Yes the SQL runs through _run_write_sql RPC
        // (whitelist-guarded), gets logged in db_write_log.
        //
        // This is what replaces "你去 supabase 跑这条 SQL" — Leon
        // writes the SQL itself, admin one-clicks.
        const description = String(args.description ?? "").trim();
        const sqlTemplate = String(args.sql_template ?? "").trim();
        const proposalReason = String(args.proposal_reason ?? "").trim();
        const name = typeof args.name === "string" ? args.name.trim() : undefined;
        const paramValues = Array.isArray(args.param_values)
          ? (args.param_values as unknown[]).map((v) => {
              if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") return v;
              return String(v);
            })
          : [];
        if (!description || !sqlTemplate || !proposalReason) {
          return { tool: call.tool, result: { error: "description, sql_template, proposal_reason all required" } };
        }
        const { proposeDynamicWrite } = await import("@/lib/dynamic-writes");
        const r = await proposeDynamicWrite({
          name,
          description,
          sql_template: sqlTemplate,
          param_values: paramValues,
          proposal_reason: proposalReason,
          proposed_by_rep_id: session.repId,
        });
        if (!r.ok) return { tool: call.tool, result: { error: r.error } };
        return {
          tool: call.tool,
          result: {
            ok: true,
            id: r.id,
            inbox_id: r.inbox_id,
            target_table: r.target_table,
            message: `Pushed DB-write proposal to admin Lark card. Tell user: 我把 SQL 写好推给 admin 了, 等他点 Yes 就执行.`,
          },
        };
      }
      case "list_dynamic_writes": {
        const { listDynamicWrites } = await import("@/lib/dynamic-writes");
        const status = ["pending", "approved", "rejected", "applied", "apply_failed", "all"].includes(
          String(args.status ?? ""),
        )
          ? (String(args.status) as "pending" | "approved" | "rejected" | "applied" | "apply_failed" | "all")
          : "pending";
        const limit = Math.max(1, Math.min(100, Number(args.limit) || 20));
        const rows = await listDynamicWrites({ status, limit });
        return {
          tool: call.tool,
          result: {
            status,
            count: rows.length,
            writes: rows.map((w) => ({
              id: w.id,
              name: w.name,
              description: w.description,
              target_table: w.target_table,
              status: w.status,
              sql_template: w.sql_template,
              param_values: w.param_values,
              proposal_reason: w.proposal_reason,
              proposed_at: w.proposed_at,
              applied_at: w.applied_at,
              apply_error: w.apply_error,
              apply_result: w.apply_result,
            })),
          },
        };
      }
      case "propose_tool": {
        // Leon authors a new SQL-backed tool. Inserts into dynamic_tools
        // (status=pending) and pushes an admin Lark card with Yes/No.
        // Approval → tool is callable from the same ```lookup``` syntax
        // as built-ins, no deploy needed.
        const name = String(args.name ?? "").trim();
        const description = String(args.description ?? "").trim();
        const sqlTemplate = String(args.sql_template ?? "").trim();
        const proposalReason = String(args.proposal_reason ?? "").trim();
        const paramOrder = Array.isArray(args.param_order) ? (args.param_order as unknown[]).map(String) : [];
        const argsSchema = (args.args_schema && typeof args.args_schema === "object")
          ? args.args_schema as Record<string, { type: string; default?: unknown; description?: string }>
          : {};
        if (!name || !description || !sqlTemplate || !proposalReason) {
          return { tool: call.tool, result: { error: "name, description, sql_template, proposal_reason all required" } };
        }
        // Type check on argsSchema before handing to the lib
        const cleanSchema: Record<string, { type: "string" | "number" | "boolean"; default?: string | number | boolean; description?: string }> = {};
        for (const [k, v] of Object.entries(argsSchema)) {
          const t = (v as { type: string }).type;
          if (t !== "string" && t !== "number" && t !== "boolean") {
            return { tool: call.tool, result: { error: `args_schema['${k}'].type must be 'string'|'number'|'boolean'` } };
          }
          cleanSchema[k] = {
            type: t,
            default: (v as { default?: string | number | boolean }).default,
            description: (v as { description?: string }).description,
          };
        }
        const { proposeDynamicTool } = await import("@/lib/dynamic-tools");
        const r = await proposeDynamicTool({
          name,
          description,
          args_schema: cleanSchema,
          sql_template: sqlTemplate,
          param_order: paramOrder,
          proposal_reason: proposalReason,
          proposed_by_rep_id: session.repId,
        });
        if (!r.ok) return { tool: call.tool, result: { error: r.error } };
        return {
          tool: call.tool,
          result: {
            ok: true,
            id: r.id,
            inbox_id: r.inbox_id,
            message: `Pushed proposal '${name}' to admin Lark card. Tell user: 我给 admin 推了个工具提案叫 ${name}, 等他 approve 就能用了.`,
          },
        };
      }
      case "list_dynamic_tools": {
        // Show what Leon-authored tools exist (any status).
        const { listDynamicTools } = await import("@/lib/dynamic-tools");
        const status = ["pending", "approved", "rejected", "deprecated", "all"].includes(String(args.status ?? ""))
          ? (String(args.status) as "pending" | "approved" | "rejected" | "deprecated" | "all")
          : "approved";
        const limit = Math.max(1, Math.min(100, Number(args.limit) || 30));
        const rows = await listDynamicTools({ status, limit });
        return {
          tool: call.tool,
          result: {
            status,
            count: rows.length,
            tools: rows.map((t) => ({
              id: t.id,
              name: t.name,
              description: t.description,
              args_schema: t.args_schema,
              param_order: t.param_order,
              status: t.status,
              call_count: t.call_count,
              last_called_at: t.last_called_at,
              last_error: t.last_error,
              proposed_by_rep_id: t.proposed_by_rep_id,
              proposed_at: t.proposed_at,
              proposal_reason: t.proposal_reason,
            })),
          },
        };
      }
      case "approve_dynamic_tool": {
        // Admin-only fast path: approve a pending dynamic tool by id.
        if (session.role !== "admin") {
          return { tool: call.tool, result: { error: "admin only" } };
        }
        const toolId = String(args.tool_id ?? "").trim();
        if (!toolId) return { tool: call.tool, result: { error: "tool_id required" } };
        const { approveDynamicTool } = await import("@/lib/dynamic-tools");
        const r = await approveDynamicTool({
          tool_id: toolId,
          approved_by_rep_id: session.repId!,
          note: typeof args.note === "string" ? args.note : undefined,
        });
        return { tool: call.tool, result: r };
      }
      case "add_to_lark_base": {
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
        if (r.ok && r.record_id) {
          await supabase.from("helper_artifacts").insert({
            rep_id: session.repId, kind: "lark_base",
            lark_id: r.record_id,
            title: `Row in ${tableId.slice(0, 12)}…`,
            url: null, meta: { app_token: appToken, table_id: tableId, field_count: Object.keys(fields).length },
          });
        }
        return { tool: call.tool, result: r as unknown as Record<string, unknown> };
      }
      case "send_lead_email": {
        // "Send the X one" — Leon dispatches the existing send route on
        // behalf of the current rep. We deliberately go through the
        // HTTP route (not via a direct lib call) so EVERY gate fires
        // exactly as it would for a dashboard click: trust-wheels cap,
        // ownership, age gate, override quota, contact firewall, claim
        // race, blocklist. The chat-side surface is intentionally
        // smaller than the dashboard's — no draft editing here, the
        // existing draft_html / draft_subject goes out as-is.
        const leadId = String(args.lead_id ?? "").trim();
        if (!leadId) {
          return { tool: call.tool, result: { error: "lead_id required" } };
        }
        const override = Boolean(args.override === true);
        // Mint an internal session cookie for THIS rep so the route's
        // requireSession() recognizes us. This works because we're
        // signing with the same AUTH_SECRET the route verifies against.
        const { signSession, AUTH_COOKIE } = await import("@/lib/auth");
        const token = await signSession({
          repId: session.repId,
          repName: session.repName ?? "",
          email: session.email ?? "",
          role: (session.role === "admin" || session.role === "senior" || session.role === "sales")
            ? session.role
            : "sales",
        });
        // Resolve the production origin. Vercel auto-injects VERCEL_URL
        // for runtime; falls back to the canonical custom domain so a
        // misconfigured env doesn't break sends.
        const origin = process.env.VERCEL_URL
          ? `https://${process.env.VERCEL_URL}`
          : "https://calistamind.com";
        try {
          const res = await fetch(`${origin}/api/pipeline/send`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              cookie: `${AUTH_COOKIE}=${token}`,
            },
            body: JSON.stringify({ id: leadId, override }),
            signal: AbortSignal.timeout(30_000),
          });
          const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
          if (!res.ok) {
            // Pass route's own error code/message through — those are
            // already formatted for sales-facing context.
            return { tool: call.tool, result: { error: j.error ?? `HTTP ${res.status}`, status: res.status, code: j.code, ...j } };
          }
          return { tool: call.tool, result: { ok: true, ...j } };
        } catch (e) {
          return { tool: call.tool, result: { error: String(e).slice(0, 200) } };
        }
      }
      case "read_lark_chat_history": {
        // Admin-only. Reads recent messages from a chat the bot is in.
        // Used for "what did Leo say in 销售群?" — admin pulls context
        // without manually scrolling. Sales reps can't call this — it
        // would be too easy to misuse for "spy on what others said".
        if (session.role !== "admin") {
          return { tool: call.tool, result: { error: "admin only" } };
        }
        const chatId = String(args.chat_id ?? "").trim();
        if (!/^oc_[A-Za-z0-9]+$/.test(chatId)) {
          return { tool: call.tool, result: { error: "chat_id must look like oc_xxx" } };
        }
        const pageSize = Math.max(1, Math.min(50, Number(args.page_size) || 20));
        const { readChatHistory } = await import("@/lib/lark");
        const r = await readChatHistory({ chat_id: chatId, page_size: pageSize });
        return { tool: call.tool, result: r as unknown as Record<string, unknown> };
      }
      case "record_admin_request": {
        // Leon writes a structured note for the admin queue (admin_inbox).
        // Idempotent via dedup_hash: same kind + headline + source_rep_id
        // → update the existing row instead of inserting a duplicate.
        const kind = String(args.kind ?? "observation").toLowerCase();
        if (kind !== "request" && kind !== "observation" && kind !== "idea") {
          return { tool: call.tool, result: { error: "kind must be one of: request, observation, idea" } };
        }
        const headline = String(args.headline ?? "").trim().slice(0, 200);
        const body = typeof args.body === "string" ? args.body.slice(0, 4000) : null;
        const evidence = args.evidence && typeof args.evidence === "object" ? args.evidence : null;
        if (!headline) {
          return { tool: call.tool, result: { error: "headline required" } };
        }
        // The current rep IS the source unless explicitly overridden.
        // If admin is using Leon, source_rep_id stays admin's id (which
        // is fine — it just means "Leon noticed this while talking to admin").
        const sourceRepId = typeof args.source_rep_id === "number"
          ? args.source_rep_id
          : session.repId;
        // dedup hash via Web Crypto (no external dep). Hashes stable
        // identity components so the same observation collapses.
        const enc = new TextEncoder();
        const key = `${kind}|${headline.toLowerCase()}|${sourceRepId ?? ""}`;
        const buf = await crypto.subtle.digest("SHA-256", enc.encode(key));
        const dedupHash = Array.from(new Uint8Array(buf))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        const { data: existing } = await supabase
          .from("admin_inbox")
          .select("id, status")
          .eq("dedup_hash", dedupHash)
          .maybeSingle();
        if (existing) {
          // Update body/evidence (refresh context) but DON'T flip status
          // back to 'new' if admin already acknowledged/dismissed it —
          // that would re-spam the inbox.
          await supabase
            .from("admin_inbox")
            .update({ body, evidence, updated_at: new Date().toISOString() })
            .eq("id", existing.id);
          return {
            tool: call.tool,
            result: { ok: true, id: existing.id, deduped: true, existing_status: existing.status },
          };
        }
        const { data, error } = await supabase
          .from("admin_inbox")
          .insert({
            kind,
            headline,
            body,
            source_rep_id: sourceRepId ?? null,
            evidence,
            dedup_hash: dedupHash,
          })
          .select("id, status")
          .single();
        if (error) return { tool: call.tool, result: { error: error.message } };

        // Push a Lark interactive card to admin's DM with Ack /
        // Save-as-memory / Dismiss buttons. This is the "admin inbox
        // in Lark" the user asked for — most pings should be triageable
        // in one tap from the same surface where Leon writes them.
        // Best-effort: card failure doesn't block the inbox insert.
        try {
          const { sendAdminInboxCard } = await import("@/lib/admin-inbox-card");
          // Optional: look up source rep name so the card surfaces it
          let sourceRepName: string | null = null;
          if (sourceRepId != null) {
            const { data: sr } = await supabase
              .from("sales_reps")
              .select("name, lark_name")
              .eq("id", sourceRepId)
              .maybeSingle();
            sourceRepName = (sr?.lark_name as string | null) ?? (sr?.name as string | null) ?? null;
          }
          await sendAdminInboxCard({
            inbox_id: data.id as string,
            kind,
            headline,
            body,
            source_rep_id: sourceRepId ?? null,
            source_rep_name: sourceRepName,
            // If the source rep is admin themselves, it's an admin-self note;
            // otherwise it's Leon noticing something during a rep conversation.
            evidence: { source: sourceRepId === session.repId && session.role === "admin"
              ? "admin_self"
              : "leon_observation" },
          });
        } catch (e) {
          console.error("[record_admin_request] card push failed (non-blocking):", e);
        }

        return { tool: call.tool, result: { ok: true, id: data.id, deduped: false, card_sent: true } };
      }
      case "escalate_to_admin": {
        // Leon doesn't know the answer with confidence → ask admin
        // directly. This is the "must escalate when unsure" rail: Leon
        // can never answer-by-guessing a hard question without pinging
        // admin. Writes an admin_inbox row (kind=request) and pushes
        // a Lark card with Yes/No buttons. Tracks my_best_guess +
        // why_unsure in evidence so admin sees the reasoning AND can
        // grade the guess.
        //
        // Distinct from record_admin_request: that's "I think you
        // should DO X"; this is "I DON'T KNOW the answer to a rep's
        // question, please tell me what to say".
        const question = String(args.question ?? "").trim().slice(0, 500);
        const myGuess = typeof args.my_best_guess === "string" ? args.my_best_guess.slice(0, 1000) : null;
        const whyUnsure = typeof args.why_unsure === "string" ? args.why_unsure.slice(0, 600) : null;
        const askedByRepId = typeof args.asked_by_rep_id === "number" ? args.asked_by_rep_id : session.repId;
        if (!question) {
          return { tool: call.tool, result: { error: "question required" } };
        }

        // Headline is the question itself (≤200 chars). Body shows
        // Leon's working: best guess + why unsure.
        const headline = "❓ Leon 不确定: " + question.slice(0, 160 - "❓ Leon 不确定: ".length);
        const bodyParts: string[] = [];
        if (myGuess) bodyParts.push(`**我的猜测:**\n${myGuess}`);
        if (whyUnsure) bodyParts.push(`**为什么不确定:**\n${whyUnsure}`);
        bodyParts.push(`_来自 rep_id=${askedByRepId}_`);
        const body = bodyParts.join("\n\n").slice(0, 4000);

        // Dedup: same question text in same week → don't re-spam admin
        const enc = new TextEncoder();
        const week = Math.floor(Date.now() / (7 * 86_400_000));
        const key = `escalation|${question.toLowerCase()}|${askedByRepId ?? ""}|${week}`;
        const buf = await crypto.subtle.digest("SHA-256", enc.encode(key));
        const dedupHash = Array.from(new Uint8Array(buf))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");

        const { data: existing } = await supabase
          .from("admin_inbox")
          .select("id, status")
          .eq("dedup_hash", dedupHash)
          .maybeSingle();
        if (existing) {
          await supabase
            .from("admin_inbox")
            .update({
              body,
              evidence: { my_best_guess: myGuess, why_unsure: whyUnsure, asked_by_rep_id: askedByRepId },
              updated_at: new Date().toISOString(),
            })
            .eq("id", existing.id);
          return {
            tool: call.tool,
            result: { ok: true, id: existing.id, deduped: true, existing_status: existing.status },
          };
        }

        const evidence = {
          my_best_guess: myGuess,
          why_unsure: whyUnsure,
          asked_by_rep_id: askedByRepId,
          escalation_source: "leon_uncertain",
          at: new Date().toISOString(),
        };
        const { data, error } = await supabase
          .from("admin_inbox")
          .insert({
            kind: "request",
            headline,
            body,
            source_rep_id: askedByRepId,
            evidence,
            dedup_hash: dedupHash,
          })
          .select("id")
          .single();
        if (error) return { tool: call.tool, result: { error: error.message } };

        // Push Lark card (Yes/No buttons since kind=request)
        try {
          const { sendAdminInboxCard } = await import("@/lib/admin-inbox-card");
          let askedByRepName: string | null = null;
          if (askedByRepId != null) {
            const { data: rep } = await supabase
              .from("sales_reps")
              .select("name")
              .eq("id", askedByRepId)
              .maybeSingle();
            askedByRepName = rep?.name ?? null;
          }
          await sendAdminInboxCard({
            inbox_id: data.id,
            kind: "request",
            headline,
            body,
            source_rep_id: askedByRepId,
            source_rep_name: askedByRepName,
            evidence: { source: "leon_uncertain", my_best_guess: myGuess, why_unsure: whyUnsure },
          });
        } catch (err) {
          console.warn("[escalate_to_admin] card push failed (non-blocking):", err);
        }

        return {
          tool: call.tool,
          result: {
            ok: true,
            id: data.id,
            escalated: true,
            message: `Pushed Lark card to admin. Tell rep: 这个我不确定, 已经在问 admin, 等他回我就告诉你.`,
          },
        };
      }
      case "list_admin_inbox": {
        // Admin asks Leon "what have you been noticing?" — read pending
        // entries. Defaults to status='new'. Sales reps can't read this
        // (it's admin's queue).
        if (session.role !== "admin") {
          return { tool: call.tool, result: { error: "admin only" } };
        }
        const status = typeof args.status === "string" ? args.status : "new";
        const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));
        const { data, error } = await supabase
          .from("admin_inbox")
          .select("id, kind, headline, body, source_rep_id, evidence, status, created_at, updated_at")
          .eq("status", status)
          .order("created_at", { ascending: false })
          .limit(limit);
        if (error) return { tool: call.tool, result: { error: error.message } };
        return {
          tool: call.tool,
          result: {
            status,
            count: (data ?? []).length,
            items: data ?? [],
          },
        };
      }
      case "mark_admin_inbox": {
        // Admin updates the status of an admin_inbox entry. 'acknowledged'
        // = "I saw this", 'done' = "I acted on it", 'dismissed' = "ignore".
        if (session.role !== "admin") {
          return { tool: call.tool, result: { error: "admin only" } };
        }
        const id = String(args.id ?? "").trim();
        const newStatus = String(args.status ?? "").toLowerCase();
        if (!id) return { tool: call.tool, result: { error: "id required" } };
        if (!["acknowledged", "dismissed", "done"].includes(newStatus)) {
          return { tool: call.tool, result: { error: "status must be one of: acknowledged, dismissed, done" } };
        }
        const { error } = await supabase
          .from("admin_inbox")
          .update({ status: newStatus, acted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq("id", id);
        if (error) return { tool: call.tool, result: { error: error.message } };
        return { tool: call.tool, result: { ok: true, id, status: newStatus } };
      }
      case "react_to_message": {
        // Drop a Lark emoji reaction on a message instead of replying
        // with text. Defaults to the message Leon is currently
        // responding to (session.messageId, threaded in via lark-agent).
        // Use cases: rep says "just sent the X one" → ✅, "thanks" → 👍.
        // The "no reply" behavior must be enforced by the LLM via the
        // catalog instructions; this tool only fires the reaction.
        const { reactToMessage } = await import("@/lib/lark");
        const explicitId = typeof args.message_id === "string" ? args.message_id.trim() : "";
        const messageId = explicitId || session.messageId || "";
        if (!messageId) {
          return { tool: call.tool, result: { error: "no message_id available (session has none and none provided)" } };
        }
        const emoji = String(args.emoji ?? "OK").toUpperCase();
        const allowed = ["EYES", "OK", "THUMBSUP", "DONE", "HEART"] as const;
        if (!(allowed as readonly string[]).includes(emoji)) {
          return { tool: call.tool, result: { error: `emoji must be one of ${allowed.join(", ")}` } };
        }
        const r = await reactToMessage({
          message_id: messageId,
          emoji_type: emoji as (typeof allowed)[number],
        });
        return { tool: call.tool, result: r as unknown as Record<string, unknown> };
      }
      case "get_recent_inbound": {
        // "Any new replies?" — list inbound emails to this rep's threads.
        // Scoped via inbound_emails.rep_id (set by migration 014). Admin
        // can pass repId in args to inspect a rep; sales sees only own.
        // We synthesize a snippet from `text` since the column itself
        // doesn't carry one. Schema: id, from, to, subject, html, text,
        // thread_id, is_read, rep_id, created_at.
        const target = scopeRepId(session, args);
        const days = Math.max(1, Math.min(30, Number(args.days) || 7));
        const limit = Math.max(1, Math.min(20, Number(args.limit) || 10));
        const since = new Date(Date.now() - days * 86_400_000).toISOString();
        let q = supabase
          .from("inbound_emails")
          .select("id, from, subject, text, thread_id, is_read, created_at")
          .gte("created_at", since)
          .order("created_at", { ascending: false })
          .limit(limit);
        if (target !== null) q = q.eq("rep_id", target);
        const { data, error } = await q;
        if (error) return { tool: call.tool, result: { error: error.message } };
        return {
          tool: call.tool,
          result: {
            windowDays: days,
            count: (data ?? []).length,
            replies: (data ?? []).map((m) => ({
              id: m.id,
              from: m.from,
              subject: m.subject,
              snippet:
                typeof m.text === "string"
                  ? m.text.replace(/\s+/g, " ").trim().slice(0, 200)
                  : null,
              thread_id: m.thread_id,
              unread: !m.is_read,
              received_at: m.created_at,
            })),
          },
        };
      }
      case "mark_wechat_added": {
        // Rep tells Leon "I added X on WeChat". Same effect as clicking
        // "Added on WeChat" in /emails — flips brief_lookups.wechat_at,
        // sets marked_by_rep_id to the ACTING rep (NOT necessarily the
        // lead owner) per CLAUDE.md actor-vs-owner rule: "the closer
        // gets credit". Idempotent — calling twice doesn't double-count
        // (relies on ux_brief_lookups_wechat_per_lead unique index).
        const leadId = String(args.lead_id ?? "").trim();
        const notes = typeof args.notes === "string" ? args.notes.slice(0, 500) : null;
        if (!leadId) {
          return { tool: call.tool, result: { error: "lead_id required" } };
        }
        // Look up the lead so we can fill query (= recipient email),
        // arxiv_id, and confirm the row exists. Sales/admin can mark
        // any active lead; we don't enforce ownership (per CLAUDE.md
        // "records over people" — wechat marking is the closer's act).
        const { data: lead } = await supabase
          .from("pipeline_leads")
          .select("id, author_email, arxiv_id, author_name, title")
          .eq("id", leadId)
          .maybeSingle();
        if (!lead) {
          return { tool: call.tool, result: { error: `lead ${leadId} not found` } };
        }
        const payload = {
          query: lead.author_email ?? lead.author_name ?? leadId,
          arxiv_id: lead.arxiv_id ?? null,
          lead_id: leadId,
          added_wechat: true,
          wechat_at: new Date().toISOString(),
          notes,
          marked_by_rep_id: session.repId,
          marked_by_email: session.email,
        };
        const { data, error } = await supabase
          .from("brief_lookups")
          .upsert(payload, { onConflict: "lead_id", ignoreDuplicates: false })
          .select("id, wechat_at, marked_by_rep_id")
          .single();
        if (error) {
          return { tool: call.tool, result: { error: error.message } };
        }
        return {
          tool: call.tool,
          result: {
            ok: true,
            lead_id: leadId,
            recipient: lead.author_email ?? lead.author_name,
            paper_title: lead.title,
            marked_at: data?.wechat_at,
            marked_by_rep_id: data?.marked_by_rep_id,
          },
        };
      }
      case "get_my_artifacts": {
        const kind = args.kind ? String(args.kind) : null;
        const days = Math.max(1, Math.min(180, Number(args.days) || 30));
        const limit = Math.max(1, Math.min(50, Number(args.limit) || 10));
        const since = new Date(Date.now() - days * 86_400_000).toISOString();
        let q = supabase.from("helper_artifacts")
          .select("id, kind, lark_id, title, url, meta, created_at")
          .eq("rep_id", session.repId)
          .gte("created_at", since)
          .order("created_at", { ascending: false })
          .limit(limit);
        if (kind) q = q.eq("kind", kind);
        const { data } = await q;
        return { tool: call.tool, result: { artifacts: data ?? [] } };
      }

      // ── Mapping module tools ────────────────────────────────────────
      case "get_my_targets": {
        // List mapping targets owned by this rep (or all if admin).
        const targetRep = session.role === "admin" && args.rep_id ? Number(args.rep_id) : session.repId;
        const { data } = await supabase
          .from("mapping_targets")
          .select("id, owner_rep_id, label, spec, candidate_active, active, created_at")
          .eq("owner_rep_id", targetRep)
          .eq("active", true)
          .order("created_at", { ascending: false });
        return { tool: call.tool, result: { targets: data ?? [] } };
      }
      case "get_pending_drafts": {
        const targetId = args.target_id ? String(args.target_id) : null;
        const limit = Math.max(1, Math.min(20, Number(args.limit) || 10));
        let q = supabase
          .from("mapping_drafts")
          .select("id, target_id, lead_id, subject, body_html, match_reason, created_at, target:mapping_targets(label, owner_rep_id)")
          .eq("state", "pending")
          .order("created_at", { ascending: false })
          .limit(limit);
        if (targetId) q = q.eq("target_id", targetId);
        const { data } = await q;
        // Filter to only drafts the rep owns (admin sees all)
        const filtered = (data ?? []).filter((d) =>
          session.role === "admin" || (d.target as unknown as { owner_rep_id: number } | null)?.owner_rep_id === session.repId
        );
        return { tool: call.tool, result: { drafts: filtered } };
      }
      case "create_mapping_target": {
        const label = String(args.label ?? "").trim();
        const spec = (args.spec && typeof args.spec === "object") ? args.spec as Record<string, unknown> : null;
        if (!label || !spec) return { tool: call.tool, result: { error: "label, spec required" } };
        const { createTarget } = await import("@/lib/mapping");
        const r = await createTarget({
          owner_rep_id: session.repId,
          label,
          spec: spec as never, // TargetSpec shape
          guidelines: typeof args.guidelines === "string" ? args.guidelines : undefined,
        });
        return { tool: call.tool, result: r as unknown as Record<string, unknown> };
      }
      case "find_mapping_candidates": {
        const targetId = String(args.target_id ?? "").trim();
        if (!targetId) return { tool: call.tool, result: { error: "target_id required" } };
        const { findCandidateLeads } = await import("@/lib/mapping");
        const r = await findCandidateLeads({ target_id: targetId, limit: Number(args.limit) || 10 });
        return { tool: call.tool, result: r as unknown as Record<string, unknown> };
      }
      case "draft_for_lead": {
        const targetId = String(args.target_id ?? "").trim();
        const leadId = String(args.lead_id ?? "").trim();
        if (!targetId || !leadId) return { tool: call.tool, result: { error: "target_id, lead_id required" } };
        const { draftForLead } = await import("@/lib/mapping");
        const r = await draftForLead({ target_id: targetId, lead_id: leadId });
        return { tool: call.tool, result: r as unknown as Record<string, unknown> };
      }
      case "decide_draft": {
        const draftId = String(args.draft_id ?? "").trim();
        const decision = String(args.decision ?? "").trim();
        if (!draftId || !["approve", "reject", "edit_and_approve"].includes(decision)) {
          return { tool: call.tool, result: { error: "draft_id, decision (approve|reject|edit_and_approve) required" } };
        }
        const { decideDraft } = await import("@/lib/mapping");
        const r = await decideDraft({
          draft_id: draftId,
          decision: decision as "approve" | "reject" | "edit_and_approve",
          decided_by: session.repId,
          edited_subject: typeof args.edited_subject === "string" ? args.edited_subject : undefined,
          edited_body_html: typeof args.edited_body_html === "string" ? args.edited_body_html : undefined,
          reject_reason: typeof args.reject_reason === "string" ? args.reject_reason : undefined,
        });
        return { tool: call.tool, result: r as unknown as Record<string, unknown> };
      }
      case "run_target_evolution": {
        if (session.role !== "admin") return { tool: call.tool, result: { error: "admin only" } };
        const targetId = String(args.target_id ?? "").trim();
        if (!targetId) return { tool: call.tool, result: { error: "target_id required" } };
        const { runEvolutionLoop } = await import("@/lib/mapping");
        const r = await runEvolutionLoop({ target_id: targetId });
        return { tool: call.tool, result: r as unknown as Record<string, unknown> };
      }

      // ── Bench-economy read tools ───────────────────────────────────
      // The bot can describe the timeline museum, current contracts,
      // pending proposals, investor convictions, and meeting transcripts.
      // Admin-only because the bench economy is not surfaced to sales.
      case "get_congress_state": {
        if (session.role !== "admin") return { tool: call.tool, result: { error: "admin only" } };
        const [{ data: companies }, { data: contracts }, { data: bets }, { data: ledger }, { data: pendingProps }] = await Promise.all([
          supabase.from("bench_companies").select("id, name, active, target_segment, thesis").order("created_at"),
          supabase.from("company_contracts").select("id, company_id, state, target_score, running_score, opened_at, closes_at").order("opened_at", { ascending: false }).limit(40),
          supabase.from("investor_bets").select("investor_id, company_id, conviction, action, decided_at").order("decided_at", { ascending: false }).limit(60),
          supabase.from("investor_capital_ledger").select("investor_id, balance_after, occurred_at").order("occurred_at", { ascending: false }),
          supabase.from("company_proposals").select("id, company_id, state").in("state", ["editor_review", "admin_review"]),
        ]);
        const balByInv = new Map<string, number>();
        for (const r of ledger ?? []) {
          if (!balByInv.has(r.investor_id as string)) balByInv.set(r.investor_id as string, Number(r.balance_after));
        }
        const latestBetByCo = new Map<string, { conviction: number; action: string; decided_at: string }>();
        for (const b of bets ?? []) {
          const key = b.company_id as string;
          if (!latestBetByCo.has(key)) latestBetByCo.set(key, { conviction: Number(b.conviction), action: String(b.action), decided_at: b.decided_at as string });
        }
        const pendingByCo = new Map<string, number>();
        for (const p of pendingProps ?? []) pendingByCo.set(p.company_id as string, (pendingByCo.get(p.company_id as string) ?? 0) + 1);
        const companyView = (companies ?? []).map((c) => {
          const cid = c.id as string;
          const myContracts = (contracts ?? []).filter((ct) => ct.company_id === cid);
          const hit = myContracts.filter((c2) => c2.state === "hit").length;
          const miss = myContracts.filter((c2) => c2.state === "missed").length;
          const open = myContracts.filter((c2) => c2.state === "open").length;
          return {
            id: cid, name: c.name, active: c.active, target_segment: c.target_segment, thesis: c.thesis,
            record: { hit, miss, open },
            latest_bet: latestBetByCo.get(cid) ?? null,
            pending_proposals: pendingByCo.get(cid) ?? 0,
          };
        });
        return { tool: call.tool, result: { companies: companyView, investor_balances: Array.from(balByInv.entries()).map(([id, balance]) => ({ id, balance })) } };
      }

      case "get_company_minutes": {
        if (session.role !== "admin") return { tool: call.tool, result: { error: "admin only" } };
        const companyId = String(args.company_id ?? "").trim();
        const week = args.week != null ? Number(args.week) : null;
        if (!companyId) return { tool: call.tool, result: { error: "company_id required" } };
        let q = supabase.from("bench_step_results").select("step, loop, personas, recommendation, confidence, rationale, extra_fields, created_at").eq("company_id", companyId).order("created_at", { ascending: false });
        if (week != null) q = q.eq("step", week);
        const { data } = await q.limit(week != null ? 1 : 5);
        if (!data || data.length === 0) return { tool: call.tool, result: { meetings: [] } };
        return { tool: call.tool, result: { meetings: data.map((m) => ({
          step: m.step, loop: m.loop,
          recommendation: m.recommendation, confidence: m.confidence,
          rationale: (m.rationale as string | null)?.slice(0, 500) ?? null,
          personas: m.personas as Record<string, string>,
          debate: ((m.extra_fields as Record<string, unknown>)?.debate ?? []) as unknown[],
          attacks: ((m.extra_fields as Record<string, unknown>)?.attacks ?? []) as unknown[],
          when: m.created_at,
        })) } };
      }

      case "get_recent_proposals": {
        if (session.role !== "admin") return { tool: call.tool, result: { error: "admin only" } };
        const stateFilter = args.state ? String(args.state) : null;
        let q = supabase
          .from("company_proposals")
          .select("id, company_id, kind, state, prediction, created_at, expires_at, editor_review_id, company:bench_companies(name)")
          .order("created_at", { ascending: false })
          .limit(20);
        if (stateFilter) q = q.eq("state", stateFilter);
        const { data } = await q;
        return { tool: call.tool, result: { proposals: (data ?? []).map((p) => ({
          id: p.id,
          company: (p.company as unknown as { name: string } | null)?.name ?? null,
          kind: p.kind,
          state: p.state,
          prediction: (p.prediction as string).slice(0, 280),
          created_at: p.created_at,
          expires_at: p.expires_at,
        })) } };
      }

      case "get_investor_thinking": {
        if (session.role !== "admin") return { tool: call.tool, result: { error: "admin only" } };
        const invId = String(args.investor_id ?? "").trim();
        if (!invId) return { tool: call.tool, result: { error: "investor_id required" } };
        const [{ data: inv }, { data: bets }] = await Promise.all([
          supabase.from("investor_agents").select("id, name, style, memory").eq("id", invId).maybeSingle(),
          supabase.from("investor_bets").select("company_id, conviction, action, rationale, decided_at, company:bench_companies(name)").eq("investor_id", invId).order("decided_at", { ascending: false }).limit(20),
        ]);
        if (!inv) return { tool: call.tool, result: { error: "investor not found" } };
        return { tool: call.tool, result: {
          investor: { id: inv.id, name: inv.name, style: inv.style },
          recent_memory: ((inv.memory ?? []) as Array<{ at: string; note: string }>).slice(-12),
          recent_bets: (bets ?? []).map((b) => ({
            company: (b.company as unknown as { name: string } | null)?.name ?? null,
            conviction: Number(b.conviction),
            action: b.action,
            rationale: (b.rationale as string).slice(0, 280),
            decided_at: b.decided_at,
          })),
        } };
      }

      case "get_contract_status": {
        if (session.role !== "admin") return { tool: call.tool, result: { error: "admin only" } };
        const contractId = args.contract_id ? String(args.contract_id) : null;
        if (contractId) {
          const [{ data: ct }, { data: events }] = await Promise.all([
            supabase.from("company_contracts").select("*, company:bench_companies(name)").eq("id", contractId).maybeSingle(),
            supabase.from("contract_event_attributions").select("event_kind, points_awarded, occurred_at").eq("contract_id", contractId).order("occurred_at", { ascending: false }).limit(30),
          ]);
          if (!ct) return { tool: call.tool, result: { error: "contract not found" } };
          return { tool: call.tool, result: {
            id: ct.id, company: (ct.company as unknown as { name: string } | null)?.name ?? null,
            action_label: ct.action_label, segment: ct.segment, prediction: ct.prediction,
            target: Number(ct.target_score), running: Number(ct.running_score),
            state: ct.state, capital_staked: Number(ct.capital_staked),
            opened_at: ct.opened_at, closes_at: ct.closes_at, settled_at: ct.settled_at,
            postmortem: ct.postmortem,
            recent_events: events ?? [],
          } };
        }
        // No contract_id → list current open contracts org-wide.
        const { data } = await supabase.from("company_contracts")
          .select("id, action_label, segment, target_score, running_score, opened_at, closes_at, company:bench_companies(name)")
          .eq("state", "open")
          .order("closes_at");
        return { tool: call.tool, result: { open_contracts: (data ?? []).map((ct) => ({
          id: ct.id,
          company: (ct.company as unknown as { name: string } | null)?.name ?? null,
          action_label: ct.action_label,
          segment: ct.segment,
          target: Number(ct.target_score),
          running: Number(ct.running_score),
          opened_at: ct.opened_at,
          closes_at: ct.closes_at,
        })) } };
      }

      default: {
        // Fallthrough: maybe this is a dynamic_tool that admin approved.
        // We look it up by name and execute if found. This is what makes
        // Leon-authored tools first-class — they're callable from the
        // same ```lookup``` syntax as built-ins.
        const { loadApprovedTool, runDynamicTool } = await import("@/lib/dynamic-tools");
        const found = await loadApprovedTool(call.tool);
        if (found) {
          const r = await runDynamicTool(call.tool, args);
          if (r.ok) {
            return {
              tool: call.tool,
              result: {
                dynamic: true,
                tool_id: r.tool.id,
                description: r.tool.description,
                row_count: r.rows.length,
                rows: r.rows,
              },
            };
          }
          return { tool: call.tool, result: { error: r.error } };
        }
        return { tool: call.tool, result: { error: `unknown tool: ${call.tool}` } };
      }
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
