// GET /api/admin/team-overview — admin's at-a-glance team dashboard.
// Each rep returns as a card with: today's goal (brief), this-week
// numbers (sent / replied / wechat), today's mission progress, ready
// queue depth, last activity, and recent escalations / learnings count.
//
// Used by /missions for admins (management-game-style "unit cards")
// and by the click-in drill modal.

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

async function isAdmin(req: NextRequest): Promise<boolean> {
  const session = await requireSession(req);
  if (!session) return false;
  const { data: rep } = await supabase
    .from("sales_reps")
    .select("role")
    .eq("id", session.repId)
    .maybeSingle();
  return rep?.role === "admin";
}

export interface RepOverviewCard {
  rep_id: number;
  rep_name: string;
  role: string;
  // Brief (LLM nightly)
  today_goal: string | null;
  today_reasoning: string | null;
  today_bullets: string[];
  // KPIs (last 7 days unless noted)
  sent_7d: number;
  replied_7d: number;
  wechat_7d: number;
  ready_queue: number;
  sends_today: number;
  // Mission progress today: aggregate target vs progress
  missions_total: number;
  missions_done: number;
  // Recent signal
  last_activity_at: string | null;
  recent_escalations_7d: number;
  recent_learnings_7d: number;
  // Computed health badge (green/amber/red)
  health: "healthy" | "watch" | "stuck";
  health_reason: string;
}

/**
 * Pure data fetcher — same numbers the GET handler returns, but
 * callable from internal code paths (e.g. the stuck-rep-alarm cron)
 * without needing to fake an admin HTTP request.
 */
export async function computeTeamOverview(): Promise<{ today: string; reps: RepOverviewCard[] }> {
  const today = new Date().toISOString().slice(0, 10);
  const since7d = new Date(Date.now() - 7 * 86_400_000).toISOString();
  return _computeOverviewInner(today, since7d);
}

export async function GET(req: NextRequest) {
  if (!(await isAdmin(req))) {
    return NextResponse.json({ error: "admin only" }, { status: 403 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const since7d = new Date(Date.now() - 7 * 86_400_000).toISOString();
  return NextResponse.json(await _computeOverviewInner(today, since7d));
}

async function _computeOverviewInner(today: string, since7d: string): Promise<{ today: string; reps: RepOverviewCard[] }> {

  // 1. All active sales/senior reps
  const { data: reps } = await supabase
    .from("sales_reps")
    .select("id, name, role")
    .eq("active", true)
    .in("role", ["sales", "senior"])
    .order("id");

  if (!reps || reps.length === 0) {
    return { today, reps: [] };
  }

  const repIds = reps.map((r) => r.id);

  // 2. Today's briefs — keyed by rep_id
  const { data: briefs } = await supabase
    .from("daily_rep_brief")
    .select("rep_id, goal, reasoning, bullets")
    .eq("brief_date", today)
    .in("rep_id", repIds);
  const briefByRep = new Map((briefs ?? []).map((b) => [b.rep_id as number, b]));

  // 3. Per-rep email activity for the past 7d (sent / replied)
  const { data: emails7d } = await supabase
    .from("emails")
    .select("actor_rep_id, status, created_at")
    .in("actor_rep_id", repIds)
    .gte("created_at", since7d);
  const sentByRep = new Map<number, number>();
  const lastActByRep = new Map<number, string>();
  let sendsTodayByRep = new Map<number, number>();
  const todayStart = today + "T00:00:00";
  for (const e of emails7d ?? []) {
    const rid = e.actor_rep_id as number;
    if (rid == null) continue;
    if (["sent", "delivered", "opened", "clicked"].includes(String(e.status))) {
      sentByRep.set(rid, (sentByRep.get(rid) ?? 0) + 1);
      if ((e.created_at as string) >= todayStart) {
        sendsTodayByRep.set(rid, (sendsTodayByRep.get(rid) ?? 0) + 1);
      }
    }
    const t = e.created_at as string;
    const prev = lastActByRep.get(rid);
    if (!prev || t > prev) lastActByRep.set(rid, t);
  }

  // 4. Inbound replies and wechat conversions (last 7d).
  // The right table is `inbound_emails` (rep_id, created_at). The
  // earlier code used `email_contact_history` with `direction`+`received_at`
  // — neither column exists; PostgREST silently returned null and
  // replied_7d was always 0. Caught by audit subagent.
  const { data: inbound7d } = await supabase
    .from("inbound_emails")
    .select("rep_id")
    .in("rep_id", repIds)
    .gte("created_at", since7d);
  const repliedByRep = new Map<number, number>();
  for (const r of inbound7d ?? []) {
    const rid = r.rep_id as number;
    repliedByRep.set(rid, (repliedByRep.get(rid) ?? 0) + 1);
  }

  const { data: wechat7d } = await supabase
    .from("brief_lookups")
    .select("marked_by_rep_id")
    .in("marked_by_rep_id", repIds)
    .eq("added_wechat", true)
    .gte("wechat_at", since7d);
  const wechatByRep = new Map<number, number>();
  for (const r of wechat7d ?? []) {
    const rid = r.marked_by_rep_id as number;
    wechatByRep.set(rid, (wechatByRep.get(rid) ?? 0) + 1);
  }

  // 5. Ready queue depth — pipeline_leads assigned to this rep, status=ready
  const { data: ready } = await supabase
    .from("pipeline_leads")
    .select("assigned_rep_id, status")
    .in("assigned_rep_id", repIds)
    .eq("status", "ready");
  const readyByRep = new Map<number, number>();
  for (const r of ready ?? []) {
    const rid = r.assigned_rep_id as number;
    readyByRep.set(rid, (readyByRep.get(rid) ?? 0) + 1);
  }

  // 6. Today's missions — total + done. v_mission_today exposes the
  // progress column as `progress_count` (not `progress`); /api/missions
  // uses the right name. This route was using `progress` which is
  // undefined and made `missions_done` always 0. Caught by audit subagent.
  const { data: missionsToday } = await supabase
    .from("v_mission_today")
    .select("rep_id, target, progress_count")
    .in("rep_id", repIds);
  const missionsTotalByRep = new Map<number, number>();
  const missionsDoneByRep = new Map<number, number>();
  for (const m of missionsToday ?? []) {
    const rid = m.rep_id as number;
    missionsTotalByRep.set(rid, (missionsTotalByRep.get(rid) ?? 0) + 1);
    if ((m.progress_count as number ?? 0) >= (m.target as number)) {
      missionsDoneByRep.set(rid, (missionsDoneByRep.get(rid) ?? 0) + 1);
    }
  }

  // 7. Recent escalations (rep_questions outcome=escalated, last 7d)
  const { data: escalations7d } = await supabase
    .from("rep_questions")
    .select("rep_id")
    .in("rep_id", repIds)
    .eq("outcome", "escalated")
    .gte("asked_at", since7d);
  const escByRep = new Map<number, number>();
  for (const r of escalations7d ?? []) {
    const rid = r.rep_id as number;
    escByRep.set(rid, (escByRep.get(rid) ?? 0) + 1);
  }

  // 8. Recent learnings about this rep (scope_rep_id, last 7d)
  const { data: learnings7d } = await supabase
    .from("helper_learnings")
    .select("scope_rep_id")
    .in("scope_rep_id", repIds)
    .gte("created_at", since7d)
    .is("superseded_at", null);
  const learnByRep = new Map<number, number>();
  for (const l of learnings7d ?? []) {
    const rid = l.scope_rep_id as number;
    learnByRep.set(rid, (learnByRep.get(rid) ?? 0) + 1);
  }

  // 9. Compose cards + compute health badge
  const cards: RepOverviewCard[] = reps.map((r) => {
    const rid = r.id;
    const brief = briefByRep.get(rid);
    const sent7d = sentByRep.get(rid) ?? 0;
    const sendsToday = sendsTodayByRep.get(rid) ?? 0;
    const missionsTotal = missionsTotalByRep.get(rid) ?? 0;
    const missionsDone = missionsDoneByRep.get(rid) ?? 0;
    const lastAct = lastActByRep.get(rid) ?? null;
    const ready = readyByRep.get(rid) ?? 0;

    // Health logic — three buckets:
    //   stuck  = no activity in 48h AND ready_queue > 0  → red
    //   watch  = missions exist + not done, OR sent_7d < 5 → amber
    //   healthy = everything else                          → green
    const hoursIdle = lastAct ? (Date.now() - new Date(lastAct).getTime()) / 3_600_000 : 9999;
    let health: RepOverviewCard["health"];
    let health_reason: string;
    if (hoursIdle > 48 && ready > 0) {
      health = "stuck";
      health_reason = `${Math.round(hoursIdle / 24)} 天没活动, ready 队列还有 ${ready}`;
    } else if (missionsTotal > 0 && missionsDone < missionsTotal) {
      health = "watch";
      health_reason = `今日 missions ${missionsDone}/${missionsTotal}`;
    } else if (sent7d < 5) {
      health = "watch";
      health_reason = `这周 sends 只有 ${sent7d}`;
    } else {
      health = "healthy";
      health_reason = `这周 ${sent7d} sends, ${repliedByRep.get(rid) ?? 0} replies`;
    }

    return {
      rep_id: rid,
      rep_name: r.name,
      role: r.role,
      today_goal: (brief?.goal as string) ?? null,
      today_reasoning: (brief?.reasoning as string) ?? null,
      today_bullets: (brief?.bullets as string[]) ?? [],
      sent_7d: sent7d,
      replied_7d: repliedByRep.get(rid) ?? 0,
      wechat_7d: wechatByRep.get(rid) ?? 0,
      ready_queue: ready,
      sends_today: sendsToday,
      missions_total: missionsTotal,
      missions_done: missionsDone,
      last_activity_at: lastAct,
      recent_escalations_7d: escByRep.get(rid) ?? 0,
      recent_learnings_7d: learnByRep.get(rid) ?? 0,
      health,
      health_reason,
    };
  });

  return { today, reps: cards };
}
