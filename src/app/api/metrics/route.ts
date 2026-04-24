import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";
import { getRep } from "@/lib/assignment";
import { beijingDaysAgoStartUtc } from "@/lib/override-quota";

// Status progression: clicked implies delivered, delivered implies sent
const DELIVERED_STATUSES = ["delivered", "clicked", "complained"];

export async function GET(req: NextRequest) {
  // Anchor windows on Beijing day boundary so the 30-day chart + 7-day
  // week filter line up with override_quota + /api/help/opening. A UTC
  // anchor made the chart's daily buckets flip at Beijing 08:00 — a
  // send at 23:30 Beijing showed up in "yesterday" on the chart but
  // "today" in the override banner. Same boundary everywhere now.
  const thirtyDaysAgo = beijingDaysAgoStartUtc(30).toISOString();
  const sevenDaysAgo = beijingDaysAgoStartUtc(7).toISOString();

  // Auth required. Fail-closed: no session → 401. A non-privileged user
  // with no resolvable rep row gets empty results (not the global
  // funnel, which used to leak when getRep returned null).
  const session = await requireSession(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const isPrivileged = session.role === "admin";
  let repFromPattern: string | null = null;
  let threadIdScope: string[] | null = null;
  if (!isPrivileged) {
    const rep = await getRep(session.repId);
    if (!rep?.sender_email) {
      // Force empty-threads scope so none of the queries match.
      threadIdScope = [];
      repFromPattern = "%__NO_REP__%";
    } else {
      repFromPattern = `%${rep.sender_email}%`;
      const { data: myOutbound } = await supabase
        .from("emails")
        .select("thread_id")
        .ilike("from", repFromPattern)
        .not("thread_id", "is", null);
      threadIdScope = (myOutbound ?? [])
        .map((r) => r.thread_id as string | null)
        .filter((t): t is string => !!t);
    }
  }

  // Tiny helper: apply the rep `from` scope to an emails count query.
  const scopedEmails = () => {
    let q = supabase.from("emails").select("*", { count: "exact", head: true });
    if (repFromPattern) q = q.ilike("from", repFromPattern);
    return q;
  };

  // Click / bounce / complained counts: union TWO sources, dedup by
  // email id.
  //   (a) emails.status in the progression set. Status is monotonic
  //       "latest event wins" — an email that clicked then complained
  //       ends up at 'complained', but that still tells us it was
  //       clicked at some point.
  //   (b) webhook_events with the matching type. Authoritative when
  //       present, but can be empty if click-tracking isn't configured
  //       on the domain (Resend off by default).
  // Earlier attempts to use either source alone had failure modes:
  // status-only undercounted mature emails; webhook_events-only showed
  // 0 forever when tracking wasn't configured. Union covers both.
  //
  // Done in JS so we don't depend on postgrest's FK registration for
  // webhook_events.email_id → emails.id, which can drift after
  // migrations without a schema-cache refresh.
  const [
    { count: totalSent },
    { count: totalDelivered },
    emailsByStatus,
    clickedWebhookIds,
    bouncedWebhookIds,
    complainedWebhookIds,
    scopedEmailIds,
    { count: totalInbound },
    { data: recentEvents },
    { count: last7DaysSent },
    { data: dailyEmails },
  ] = await Promise.all([
    scopedEmails().neq("status", "queued"),
    scopedEmails().in("status", DELIVERED_STATUSES),
    // Pull current-status + id per email so we can derive click/bounce
    // purely from the progression when webhooks are silent.
    (async () => {
      let q = supabase
        .from("emails")
        .select("id, status")
        .neq("status", "queued");
      if (repFromPattern) q = q.ilike("from", repFromPattern);
      const { data } = await q;
      return data ?? [];
    })(),
    // Webhook-event email_ids per type. No inner join — we filter by
    // cross-referencing against scopedEmailIds below.
    (async () => {
      const { data } = await supabase
        .from("webhook_events")
        .select("email_id")
        .eq("type", "email.clicked")
        .not("email_id", "is", null);
      const ids = new Set<string>();
      for (const row of data ?? []) if (row.email_id) ids.add(row.email_id as string);
      return ids;
    })(),
    (async () => {
      const { data } = await supabase
        .from("webhook_events")
        .select("email_id")
        .eq("type", "email.bounced")
        .not("email_id", "is", null);
      const ids = new Set<string>();
      for (const row of data ?? []) if (row.email_id) ids.add(row.email_id as string);
      return ids;
    })(),
    (async () => {
      const { data } = await supabase
        .from("webhook_events")
        .select("email_id")
        .eq("type", "email.complained")
        .not("email_id", "is", null);
      const ids = new Set<string>();
      for (const row of data ?? []) if (row.email_id) ids.add(row.email_id as string);
      return ids;
    })(),
    // Set of email IDs the caller is scoped to (admin: all, sales:
    // just theirs). Used to restrict webhook event counts to
    // emails the caller can see.
    (async () => {
      let q = supabase.from("emails").select("id");
      if (repFromPattern) q = q.ilike("from", repFromPattern);
      const { data } = await q;
      const ids = new Set<string>();
      for (const row of data ?? []) ids.add(row.id as string);
      return ids;
    })(),
    // Inbound scope: when this rep has zero threads, we skip the query
    // entirely and use {count:0} as a literal. Otherwise pass `.in()`.
    (threadIdScope !== null && threadIdScope.length === 0)
      ? Promise.resolve({ count: 0 })
      : (() => {
          let q = supabase.from("inbound_emails").select("*", { count: "exact", head: true });
          if (threadIdScope !== null) q = q.in("thread_id", threadIdScope);
          return q;
        })(),
    (async () => {
      let q = supabase
        .from("webhook_events")
        .select("id, type, created_at, email:emails!inner(to, subject, from)")
        .order("created_at", { ascending: false })
        .limit(100);
      if (repFromPattern) q = q.ilike("email.from", repFromPattern);
      return q;
    })(),
    scopedEmails().neq("status", "queued").gte("created_at", sevenDaysAgo),
    (() => {
      let q = supabase
        .from("emails")
        .select("id, created_at, status")
        .neq("status", "queued")
        .gte("created_at", thirtyDaysAgo);
      if (repFromPattern) q = q.ilike("from", repFromPattern);
      return q;
    })(),
  ]);

  // Aggregate daily stats — 30 bins anchored on Beijing days, so the
  // chart's day labels line up with "sent today" everywhere else.
  const dailyMap: Record<string, { sent: number; delivered: number; clicked: number; bounced: number }> = {};
  const todayBeijing = new Date(Date.now() + 8 * 3600 * 1000);
  for (let i = 29; i >= 0; i--) {
    const d = new Date(todayBeijing.getTime() - i * 86_400_000);
    const key = d.toISOString().split("T")[0];
    dailyMap[key] = { sent: 0, delivered: 0, clicked: 0, bounced: 0 };
  }

  // Build the final (scoped, unioned, deduped) id sets FIRST so the
  // daily-chart loop below can use them. Status sources contribute
  // whichever emails currently sit at the target status or past it
  // (e.g. a 'complained' row still counted as clicked-ever). Webhook
  // sources contribute any event ever recorded. Both are restricted
  // to emailIds the caller can see.
  const clickedIds = new Set<string>();
  const bouncedIds = new Set<string>();
  const complainedIds = new Set<string>();
  for (const e of emailsByStatus) {
    const id = e.id as string;
    const s = e.status as string;
    if (!id) continue;
    if (s === "clicked" || s === "complained") clickedIds.add(id);
    if (s === "bounced") bouncedIds.add(id);
    if (s === "complained") complainedIds.add(id);
  }
  for (const id of clickedWebhookIds)    if (scopedEmailIds.has(id)) clickedIds.add(id);
  for (const id of bouncedWebhookIds)    if (scopedEmailIds.has(id)) bouncedIds.add(id);
  for (const id of complainedWebhookIds) if (scopedEmailIds.has(id)) complainedIds.add(id);

  // Daily chart: sent + delivered come from emails.status (monotonic,
  // fine). clicked + bounced come from the id sets we just built,
  // indexed back to the email's created_at so clicks bucket into the
  // day the ORIGINAL send landed on.
  for (const email of dailyEmails || []) {
    const key = new Date(email.created_at).toISOString().split("T")[0];
    if (!dailyMap[key]) continue;
    dailyMap[key].sent++;
    if (DELIVERED_STATUSES.includes(email.status)) dailyMap[key].delivered++;
    if (email.id && clickedIds.has(email.id as string)) dailyMap[key].clicked++;
    if (email.id && bouncedIds.has(email.id as string)) dailyMap[key].bounced++;
  }

  const ts = totalSent || 0;
  const td = totalDelivered || 0;
  const tc = clickedIds.size;
  const tb = bouncedIds.size;
  const tComp = complainedIds.size;

  const deliveryRate = ts > 0 ? ((td / ts) * 100).toFixed(1) : "0";
  const clickRate = td > 0 ? ((tc / td) * 100).toFixed(1) : "0";
  const bounceRate = ts > 0 ? ((tb / ts) * 100).toFixed(1) : "0";

  // Recent events — use webhook_events if available, otherwise synthesize from emails
  let formattedEvents;
  if (recentEvents && recentEvents.length > 0) {
    formattedEvents = recentEvents.map((e) => ({
      id: e.id,
      type: e.type,
      createdAt: e.created_at,
      to: (e.email as unknown as Record<string, string> | null)?.to,
      subject: (e.email as unknown as Record<string, string> | null)?.subject,
    }));
  } else {
    const { data: recentEmails } = await supabase
      .from("emails")
      .select("id, to, subject, status, updated_at")
      .neq("status", "queued")
      .order("updated_at", { ascending: false })
      .limit(20);

    formattedEvents = (recentEmails || []).map((e) => ({
      id: e.id,
      type: `email.${e.status}`,
      createdAt: e.updated_at,
      to: e.to,
      subject: e.subject,
    }));
  }

  // Pipeline stats + WeChat — per-rep scoped for non-privileged users.
  // Previously this block returned team-wide counts regardless of role,
  // leaking other reps' numbers into the sales overview card.
  let readyQ = supabase.from("pipeline_leads").select("*", { count: "exact", head: true }).eq("status", "ready");
  let sentQ = supabase.from("pipeline_leads").select("*", { count: "exact", head: true }).eq("status", "sent");
  let totalQ = supabase.from("pipeline_leads").select("*", { count: "exact", head: true });
  if (!isPrivileged) {
    readyQ = readyQ.eq("assigned_rep_id", session.repId);
    sentQ = sentQ.eq("assigned_rep_id", session.repId);
    totalQ = totalQ.eq("assigned_rep_id", session.repId);
  }
  const [
    { count: pipelineReady },
    { count: pipelineSent },
    { count: pipelineTotal },
    { count: wechatTotal },
    { data: recentWechat },
  ] = await Promise.all([
    readyQ,
    sentQ,
    totalQ,
    // brief_lookups: admin sees global; non-priv gets 0 for now
    // (accurate per-rep attribution would need to cross-reference every
    // wechat query against this rep's delivered recipients — expensive).
    isPrivileged
      ? supabase.from("brief_lookups").select("*", { count: "exact", head: true }).eq("added_wechat", true)
      : Promise.resolve({ count: 0 }),
    isPrivileged
      ? supabase.from("brief_lookups").select("query, arxiv_id, created_at").eq("added_wechat", true).order("created_at", { ascending: false }).limit(10)
      : Promise.resolve({ data: [] as Array<{ query: string; arxiv_id: string; created_at: string }> }),
  ]);

  return NextResponse.json({
    overview: {
      totalSent: ts,
      totalDelivered: td,
      totalClicked: tc,
      totalBounced: tb,
      totalComplained: tComp,
      totalInbound: totalInbound || 0,
      last7DaysSent: last7DaysSent || 0,
      deliveryRate,
      clickRate,
      bounceRate,
    },
    pipeline: {
      ready: pipelineReady || 0,
      sent: pipelineSent || 0,
      total: pipelineTotal || 0,
    },
    wechat: {
      total: wechatTotal || 0,
      recent: (recentWechat || []).map((r) => ({
        query: r.query,
        arxivId: r.arxiv_id,
        createdAt: r.created_at,
      })),
    },
    dailyStats: Object.entries(dailyMap).map(([date, stats]) => ({ date, ...stats })),
    recentEvents: formattedEvents,
  });
}
