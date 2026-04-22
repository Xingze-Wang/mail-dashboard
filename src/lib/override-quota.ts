/**
 * Per-rep daily cap on 7-day-rule overrides.
 *
 * Why a cap: the 7-day age gate exists to stop us spamming freshly-
 * published authors. Overrides are a legitimate escape hatch for
 * high-signal leads (strong PI with a reply window closing), but if sales
 * overrides every lead the gate stops meaning anything. 200/day per rep
 * is generous enough that legitimate work isn't blocked, tight enough
 * that "override everything" habits show up.
 *
 * Beijing day boundary (UTC+8): our reps are in China, so "today" should
 * match what they see on their phone. This means the counter resets at
 * 16:00 UTC the previous day. UTC-anchored would be surprising ("I hit
 * 200 at 9am and it reset 'tomorrow' at 8am Beijing time? huh").
 */

import { supabase } from "@/lib/db";

export const DAILY_OVERRIDE_CAP = 200;

/** Start of "today" in Beijing time (UTC+8), expressed as a UTC timestamp.
 *  We build it by asking: what's the current Beijing date, then midnight
 *  of that date, then subtract 8h to get back to UTC. */
export function beijingDayStartUtc(now: Date = new Date()): Date {
  // Shift now forward 8h — whatever day that lands on in UTC is the
  // current Beijing date.
  const beijingNow = new Date(now.getTime() + 8 * 3600 * 1000);
  const y = beijingNow.getUTCFullYear();
  const m = beijingNow.getUTCMonth();
  const d = beijingNow.getUTCDate();
  // Midnight Beijing on that date, expressed as UTC = 16:00 UTC previous day.
  return new Date(Date.UTC(y, m, d, 0, 0, 0) - 8 * 3600 * 1000);
}

/** Count 7-day overrides this rep has used today (Beijing).
 *  Returns null if repId is missing (caller should treat as "no cap to
 *  enforce" — we only cap authenticated rep users). */
export async function countOverridesTodayByRep(repId: number | null | undefined): Promise<number | null> {
  if (!repId) return null;
  const dayStart = beijingDayStartUtc().toISOString();
  const { count, error } = await supabase
    .from("pipeline_leads")
    .select("id", { count: "exact", head: true })
    .eq("assigned_rep_id", repId)
    .eq("override_used", true)
    .gte("sent_at", dayStart);
  if (error) {
    // Fail-open on count errors — better to let a send through than to
    // block all overrides because of a transient DB hiccup. The cap is a
    // guardrail, not a security boundary.
    console.error("countOverridesTodayByRep failed; failing open", error);
    return 0;
  }
  return count ?? 0;
}

export interface QuotaCheck {
  ok: boolean;
  used: number;
  cap: number;
  remaining: number;
}

/** Compose a quota check result from a raw count. Handy for routes that
 *  want to bail early vs. just report usage to the client. */
export function buildQuotaCheck(used: number): QuotaCheck {
  const cap = DAILY_OVERRIDE_CAP;
  const remaining = Math.max(0, cap - used);
  return { ok: used < cap, used, cap, remaining };
}
