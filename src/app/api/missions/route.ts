import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/missions
 *
 * Returns the four mission resolutions for /missions:
 *   - quarterly: active goals + progress (computed from real data)
 *   - team_focus: this week's active focus (theme + rationale)
 *   - my_today: this rep's missions due today
 *   - team_today: every other rep's missions today (visibility)
 *
 * Auth: any logged-in rep. Reps see their own missions in detail and
 * only headline info (kind, target, progress) for teammates.
 *
 * Why all 4 in one response: /missions is a dashboard. Polling 4
 * endpoints from the same page is wasteful; one round-trip per render
 * + one per refresh is enough.
 */

interface MissionRow {
  id: string;
  rep_id: number;
  due_date: string;
  kind: string;
  target: number;
  scope: Record<string, unknown> | null;
  description: string | null;
  status: string;
  team_focus_id: string | null;
  quarterly_goal_id: string | null;
  generated_by: string;
  progress_count: number | null;
}

function isoDate(d: Date): string { return d.toISOString().slice(0, 10); }

/**
 * Monday of the week containing the given date. ISO week convention:
 * Monday=1, Sunday=7. Returns YYYY-MM-DD.
 */
function mondayOf(d: Date): string {
  const day = d.getUTCDay();
  // getUTCDay: Sunday=0, Monday=1, ..., Saturday=6.
  // Monday-of-this-week = subtract (day===0 ? 6 : day-1) days.
  const diff = day === 0 ? 6 : day - 1;
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - diff);
  return isoDate(monday);
}

export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Login required" }, { status: 401 });

  const today = isoDate(new Date());
  const monday = mondayOf(new Date());

  // ── Quarterly goals (active) ──────────────────────────────────────
  // Don't try to compute progress here — keep the read fast. Surface
  // the goal + a hint about how it's measured; the UI can fetch a
  // stat endpoint if it wants live progress.
  const { data: goals } = await supabase
    .from("quarterly_goals")
    .select("id, quarter_starting, metric, target, unit, description")
    .eq("active", true)
    .order("quarter_starting", { ascending: false });

  // ── Team focus (this week, status='active') ───────────────────────
  // Falls back to most recent active focus from ANY recent week if this
  // week's wasn't set — gives reps something to look at on Monday
  // morning before congress runs.
  let { data: focusThisWeek } = await supabase
    .from("team_focus")
    .select("id, week_starting, theme, rationale, set_by, status, congress_run_id")
    .eq("status", "active")
    .eq("week_starting", monday)
    .maybeSingle();
  if (!focusThisWeek) {
    const { data: latestActive } = await supabase
      .from("team_focus")
      .select("id, week_starting, theme, rationale, set_by, status, congress_run_id")
      .eq("status", "active")
      .order("week_starting", { ascending: false })
      .limit(1)
      .maybeSingle();
    focusThisWeek = latestActive ?? null;
  }

  // ── My missions today ─────────────────────────────────────────────
  const { data: myToday } = await supabase
    .from("v_mission_today")
    .select("*")
    .eq("rep_id", session.repId)
    .order("kind", { ascending: true });

  // ── Teammates' missions today (visibility) ────────────────────────
  // Only kind + target + progress — not the full description, not the
  // scope. Rep names resolved in one round-trip.
  const { data: teamToday } = await supabase
    .from("v_mission_today")
    .select("id, rep_id, kind, target, progress_count, status")
    .neq("rep_id", session.repId)
    .order("rep_id", { ascending: true });

  const teamRepIds = [...new Set((teamToday ?? []).map((m) => m.rep_id as number))];
  const repNames = new Map<number, string>();
  if (teamRepIds.length > 0) {
    const { data: reps } = await supabase
      .from("sales_reps")
      .select("id, sender_name, name")
      .in("id", teamRepIds);
    for (const r of reps ?? []) {
      repNames.set(
        r.id as number,
        ((r.sender_name as string | null) ?? (r.name as string | null) ?? `rep#${r.id}`),
      );
    }
  }

  // ── Today's narrative brief (LLM-generated nightly) ──────────────
  // Single-row read per visit. If the cron hasn't fired yet today or
  // the LLM failed, this is null and the page just hides the block.
  const { data: brief } = await supabase
    .from("daily_rep_brief")
    .select("goal, reasoning, bullets, admin_overrode, admin_note, computed_at")
    .eq("rep_id", session.repId)
    .eq("brief_date", today)
    .maybeSingle();

  return NextResponse.json({
    today,
    week_starting: monday,
    today_brief: brief ?? null,
    quarterly: goals ?? [],
    team_focus: focusThisWeek,
    my_today: (myToday ?? []) as MissionRow[],
    team_today: (teamToday ?? []).map((m) => ({
      ...m,
      rep_name: repNames.get(m.rep_id as number) ?? `rep#${m.rep_id}`,
    })),
  });
}
