/**
 * Mission progress helpers.
 *
 * Called from action paths (send, reply, mark-wechat) after their
 * primary work succeeds. Bumps the relevant mission_progress.count
 * for the rep's active mission of that kind on today's date.
 *
 * Defensive design:
 *   - If no active mission of that kind exists, no-op (don't error;
 *     reps without missions still need to be able to send).
 *   - If mission_progress row doesn't exist yet, insert with count=1.
 *   - Never fails the calling path — wrap in try/catch upstream.
 *   - Idempotency: progress is a counter, not a transition, so
 *     duplicate calls just increment — that's by design (each
 *     action = one count). Webhook-svix dedup already prevents
 *     double-call from upstream retries.
 *
 * Auto-completion: if count >= target, also flip mission.status to
 * 'completed' + stamp completed_at. This is what lights up the green
 * checkmark on /missions.
 */

import { supabase } from "@/lib/db";

type MissionKind =
  | "send"
  | "reply"
  | "mark_wechat"
  | "review_proposals"
  | "review_template_edits"
  | "custom";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Bump progress on the rep's active missions of `kind` due today.
 * Returns the number of mission rows touched (0 = no mission, no-op).
 */
export async function bumpMissionProgress(repId: number, kind: MissionKind, by = 1): Promise<number> {
  if (by <= 0) return 0;

  const { data: missions, error } = await supabase
    .from("missions")
    .select("id, target")
    .eq("rep_id", repId)
    .eq("kind", kind)
    .eq("due_date", todayIso())
    .eq("status", "active");
  if (error || !missions || missions.length === 0) return 0;

  let touched = 0;
  for (const m of missions) {
    const missionId = m.id as string;
    const target = m.target as number;

    // Read current count (race-safe enough for our scale — admin
    // mutations are rare, and serial mission_progress rows aren't
    // hammered by concurrent sends since each send is one-at-a-time
    // per rep). For high-volume ops this would want an atomic
    // increment via RPC; not needed today.
    const { data: prog } = await supabase
      .from("mission_progress")
      .select("count")
      .eq("mission_id", missionId)
      .maybeSingle();
    const oldCount = (prog?.count as number | null) ?? 0;
    const newCount = oldCount + by;

    if (prog) {
      await supabase
        .from("mission_progress")
        .update({ count: newCount, updated_at: new Date().toISOString() })
        .eq("mission_id", missionId);
    } else {
      await supabase
        .from("mission_progress")
        .insert({ mission_id: missionId, count: newCount });
    }

    // Auto-complete if hit target. Don't OVER-write completed_at if
    // it's already set (e.g. earlier bump that already crossed the
    // line; subsequent bumps shouldn't shift the timestamp).
    if (newCount >= target) {
      await supabase
        .from("missions")
        .update({
          status: "completed",
          completed_at: new Date().toISOString(),
        })
        .eq("id", missionId)
        .eq("status", "active");  // race-safe: only flip if still active
    }
    touched++;
  }
  return touched;
}
