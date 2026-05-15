// /api/cron/stuck-rep-alarm — proactive drought detector.
//
// Reuses the health-bucket logic from /api/admin/team-overview. When a
// rep is classified as 'stuck' (no activity in 48h AND ready_queue > 0)
// OR 'watch' (under-mission OR low send volume), Leon DMs admin a
// one-line card so the drought doesn't go unnoticed for days.
//
// Cooldown: 48h per (rep_id, kind='stuck_rep_alarm') via
// helper_chime_in_log. Without it, every cron tick re-DMs the same
// stuck rep and admin tunes out the channel.
//
// Triggered from the daily fan-out (06:00 UTC). Also safe to fire
// manually via the route.

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";

export const preferredRegion = ["hkg1"];
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const ADMIN_REP_ID = 5;
const COOLDOWN_HOURS = 48;

interface AlarmResult {
  rep_id: number;
  rep_name: string;
  health: "stuck" | "watch" | "healthy";
  reason: string;
  alarmed: boolean;
  skipped_reason?: string;
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const t0 = Date.now();

  // Pull the same numbers /admin/missions admin view uses.
  const { computeTeamOverview } = await import("@/app/api/admin/team-overview/route");
  const overview = await computeTeamOverview();

  // Cooldown lookup: pull the latest stuck_rep_alarm chime for each
  // rep, decide if we can re-fire.
  const since = new Date(Date.now() - COOLDOWN_HOURS * 3_600_000).toISOString();
  const { data: recentChimes } = await supabase
    .from("helper_chime_in_log")
    .select("rep_id, sent_at")
    .eq("kind", "stuck_rep_alarm")
    .gte("sent_at", since);
  const cooledDown = new Set((recentChimes ?? []).map((c) => c.rep_id as number));

  const results: AlarmResult[] = [];
  const alarmableReps = overview.reps.filter((r) => r.health === "stuck" || r.health === "watch");

  if (alarmableReps.length === 0) {
    return NextResponse.json({
      ran_at: new Date().toISOString(),
      duration_ms: Date.now() - t0,
      total_reps: overview.reps.length,
      alarmable: 0,
      fired: 0,
      results: [],
    });
  }

  // Pull admin's lark_open_id once
  const { data: admin } = await supabase
    .from("sales_reps")
    .select("lark_open_id")
    .eq("id", ADMIN_REP_ID)
    .maybeSingle();
  const adminOpenId = admin?.lark_open_id;
  if (!adminOpenId) {
    return NextResponse.json({ error: "admin has no lark_open_id" }, { status: 500 });
  }

  for (const rep of alarmableReps) {
    if (cooledDown.has(rep.rep_id)) {
      results.push({
        rep_id: rep.rep_id,
        rep_name: rep.rep_name,
        health: rep.health as "stuck" | "watch",
        reason: rep.health_reason,
        alarmed: false,
        skipped_reason: `cooldown active (alarmed within ${COOLDOWN_HOURS}h)`,
      });
      continue;
    }

    // Compose card payload + DM. Different framing for stuck vs watch.
    const emoji = rep.health === "stuck" ? "🔴" : "🟡";
    const headline = `${emoji} ${rep.rep_name}: ${rep.health_reason}`;
    const lastActStr = rep.last_activity_at
      ? new Date(rep.last_activity_at).toLocaleString()
      : "no recent activity";
    const lines = [
      headline,
      "",
      `**Ready queue**: ${rep.ready_queue}`,
      `**Sends this week**: ${rep.sent_7d}`,
      `**Replies this week**: ${rep.replied_7d}`,
      `**Today's missions**: ${rep.missions_done}/${rep.missions_total}`,
      `**Last activity**: ${lastActStr}`,
      "",
      rep.today_goal ? `**Today's brief**: ${rep.today_goal}` : "_no brief written for today_",
      "",
      rep.health === "stuck"
        ? `_${rep.rep_name} hasn't touched the queue in 2+ days but has a non-empty ready pool. Worth a check-in._`
        : `_${rep.rep_name} is behind today's missions or under-sending this week. Worth a nudge._`,
    ].filter(Boolean).join("\n");

    try {
      const { getTenantAccessToken, pickBase } = await import("@/lib/lark");
      const token = await getTenantAccessToken();
      if (token) {
        await fetch(`${pickBase()}/im/v1/messages?receive_id_type=open_id`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            receive_id: adminOpenId,
            msg_type: "text",
            content: JSON.stringify({ text: lines }),
          }),
          signal: AbortSignal.timeout(10_000),
        });
      }

      // Log the chime so cooldown applies next run
      await supabase.from("helper_chime_in_log").insert({
        rep_id: rep.rep_id,
        kind: "stuck_rep_alarm",
        payload: {
          health: rep.health,
          reason: rep.health_reason,
          ready_queue: rep.ready_queue,
          sent_7d: rep.sent_7d,
          missions_done: rep.missions_done,
          missions_total: rep.missions_total,
          last_activity_at: rep.last_activity_at,
        },
      });

      results.push({
        rep_id: rep.rep_id,
        rep_name: rep.rep_name,
        health: rep.health as "stuck" | "watch",
        reason: rep.health_reason,
        alarmed: true,
      });
    } catch (err) {
      results.push({
        rep_id: rep.rep_id,
        rep_name: rep.rep_name,
        health: rep.health as "stuck" | "watch",
        reason: rep.health_reason,
        alarmed: false,
        skipped_reason: `DM failed: ${String(err).slice(0, 100)}`,
      });
    }
  }

  return NextResponse.json({
    ran_at: new Date().toISOString(),
    duration_ms: Date.now() - t0,
    total_reps: overview.reps.length,
    alarmable: alarmableReps.length,
    fired: results.filter((r) => r.alarmed).length,
    results,
  });
}
