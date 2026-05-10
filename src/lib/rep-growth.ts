// Rep growth ladder — computes 4 dimension scores (1-5 each) on demand
// from existing tables. No new schema required; this is pure derivation.
//
// Used by the helper bot's get_my_growth read tool and the daily admin
// summary. The point is to give the rep an honest, evidence-grounded
// answer to "how am I doing and what's the next thing to work on?" —
// 老师傅 in the long run, useful nudge today.
//
// Dimensions:
//   1. targeting     — do their leads convert above team baseline?
//   2. writing       — how much do their drafts get edited before send?
//   3. follow_up     — when a recipient clicks, do they re-engage in 48h?
//   4. reading_room  — when a recipient replies, how fast and tailored is
//                      the response?
//
// Each dimension returns:
//   { rung: 1-5, headline, evidence, next_unlock }
//
// We use 30-day windows for the evaluation and skip dimensions where the
// rep has too little data to score honestly (n < HONEST_N).

import { supabase } from "@/lib/db";
import { CONTACTED_LEAD_STATUSES } from "@/lib/status";

const WINDOW_DAYS = 30;
const HONEST_N = 5;          // need ≥5 events in the window to score
const FOLLOWUP_WINDOW_HOURS = 48;
const REPLY_WINDOW_HOURS = 24;

export interface DimensionScore {
  name: "targeting" | "writing" | "follow_up" | "reading_room";
  label: string;          // human-readable
  rung: 1 | 2 | 3 | 4 | 5 | null;  // null = not enough data
  headline: string;       // one-line summary the helper can echo verbatim
  evidence: Record<string, number | string | null>;
  next_unlock: string | null;  // what to do to reach next rung; null at 5
}

export interface GrowthSnapshot {
  rep_id: number;
  window_days: number;
  dimensions: DimensionScore[];
  overall_rung: number | null;   // average of scored dimensions, rounded
  top_strength: DimensionScore | null;
  top_opportunity: DimensionScore | null;
  computed_at: string;
}

function windowStartIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// Bucket a number into a rung. Cuts are calibrated against typical team
// numbers — refine once we see real data come in.
function rung(value: number, cuts: [number, number, number, number]): 1 | 2 | 3 | 4 | 5 {
  if (value < cuts[0]) return 1;
  if (value < cuts[1]) return 2;
  if (value < cuts[2]) return 3;
  if (value < cuts[3]) return 4;
  return 5;
}

// Lower-is-better variant (e.g. edit distance — smaller = less rework).
function rungInverse(value: number, cuts: [number, number, number, number]): 1 | 2 | 3 | 4 | 5 {
  if (value > cuts[0]) return 1;
  if (value > cuts[1]) return 2;
  if (value > cuts[2]) return 3;
  if (value > cuts[3]) return 4;
  return 5;
}

async function scoreTargeting(repId: number, since: string): Promise<DimensionScore> {
  // Count: of the rep's contacted leads in window, what % converted (clicked
  // OR added on WeChat)? We pull pipeline_leads for the denominator and
  // brief_lookups (marked_by_rep_id) for the wechat numerator. Click signal
  // approximated by status='replied' — finer-grained click data lives in
  // webhook_events but we keep this read cheap. (Historically this comment
  // also mentioned 'wechat_added' as a status value, but that was never
  // written; it was removed from the status constants per finding #6.)
  const [{ data: contactedRows }, { data: wechatRows }] = await Promise.all([
    supabase
      .from("pipeline_leads")
      .select("id, status, sent_at")
      .eq("assigned_rep_id", repId)
      .in("status", [...CONTACTED_LEAD_STATUSES])
      .gte("sent_at", since),
    supabase
      .from("brief_lookups")
      .select("lead_id")
      .eq("added_wechat", true)
      .eq("marked_by_rep_id", repId)
      .not("lead_id", "is", null)
      .gte("created_at", since),
  ]);
  const contacted = contactedRows?.length ?? 0;
  const replied = (contactedRows ?? []).filter((l) => l.status === "replied").length;
  const wechat = new Set((wechatRows ?? []).map((r) => r.lead_id as string)).size;
  const converted = replied + wechat;  // a recipient could be both; rare, accept double-count

  if (contacted < HONEST_N) {
    return {
      name: "targeting",
      label: "选 Lead 的眼光",
      rung: null,
      headline: `Only ${contacted} sends in the last ${WINDOW_DAYS} days — need ≥${HONEST_N} to score honestly.`,
      evidence: { contacted, converted },
      next_unlock: "Send to more leads so we can compare your conversion rate against the team.",
    };
  }
  const rate = converted / contacted;
  // Cuts: 4%, 8%, 14%, 22% — very rough until we calibrate against team
  const r = rung(rate, [0.04, 0.08, 0.14, 0.22]);
  return {
    name: "targeting",
    label: "选 Lead 的眼光",
    rung: r,
    headline: `${(rate * 100).toFixed(1)}% of your last ${contacted} contacted leads converted (${converted} reply/wechat).`,
    evidence: { contacted, replied, wechat, converted, rate: Math.round(rate * 1000) / 1000 },
    next_unlock:
      r === 5
        ? null
        : r >= 3
          ? "Look at which lead_tier / school_tier converts best for you and skew higher."
          : "Try skipping low-confidence leads (use the override budget) and focus on strong-tier with citations >100.",
  };
}

async function scoreWriting(repId: number, since: string): Promise<DimensionScore> {
  // Median draft_edit_distance on rep's recent sends. Lower = less rework
  // = the AI's draft already matches their voice.
  const { data: rows } = await supabase
    .from("pipeline_leads")
    .select("draft_edit_distance, edit_reasons")
    .eq("assigned_rep_id", repId)
    .in("status", [...CONTACTED_LEAD_STATUSES])
    .not("draft_edit_distance", "is", null)
    .gte("sent_at", since);
  const dists = (rows ?? [])
    .map((r) => r.draft_edit_distance as number)
    .filter((n) => typeof n === "number")
    .sort((a, b) => a - b);
  if (dists.length < HONEST_N) {
    return {
      name: "writing",
      label: "AI 草稿的契合度",
      rung: null,
      headline: `Only ${dists.length} edited sends in window — need ≥${HONEST_N}.`,
      evidence: { samples: dists.length },
      next_unlock: "Send more drafts to build a writing-fit signal.",
    };
  }
  const median = dists[Math.floor(dists.length / 2)];

  // Tally top edit reason for the next-unlock prompt.
  const reasonCount: Record<string, number> = {};
  for (const r of rows ?? []) {
    for (const tag of (r.edit_reasons ?? []) as string[]) {
      reasonCount[tag] = (reasonCount[tag] ?? 0) + 1;
    }
  }
  const topReason = Object.entries(reasonCount).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  // Cuts: 50, 30, 15, 5 chars median — lower is better.
  const r = rungInverse(median, [50, 30, 15, 5]);
  const reasonHints: Record<string, string> = {
    format: "Most of your edits are formatting — let's update the global template's spacing/line-breaks.",
    too_robotic: "Your edits soften AI-tone phrasing — try the build_rep_template flow to bake in your voice.",
    too_verbose: "You trim length most often — we can lower the draft target word count.",
    ai_misunderstood: "Many edits fix factual misreads — review which papers triggered them.",
    individual_taste: "Edits are personal-taste tweaks — voice template should help.",
  };
  return {
    name: "writing",
    label: "AI 草稿的契合度",
    rung: r,
    headline: `Median edit distance ${median} chars over ${dists.length} sends${topReason ? ` (top reason: ${topReason})` : ""}.`,
    evidence: { samples: dists.length, median_edit_distance: median, top_reason: topReason },
    next_unlock:
      r === 5
        ? null
        : topReason && reasonHints[topReason]
          ? reasonHints[topReason]
          : "Use the helper's build_rep_template action to capture your voice into a template.",
  };
}

async function scoreFollowUp(repId: number, since: string): Promise<DimensionScore> {
  // Of recipients who clicked (latest webhook event = clicked) but didn't
  // reply, did the rep send a follow-up within FOLLOWUP_WINDOW_HOURS?
  // Cheap approximation: pull leads with status='clicked' or where
  // emails.status='clicked' joined to pipeline_leads, count how many
  // got a sent_at update or have a 2nd outbound on the thread within
  // the window. We'll look at pipeline_leads.status='replied' as a
  // proxy for "followed up successfully" until we have richer data.
  //
  // Honest read: this is the weakest of the 4 because we don't
  // explicitly track follow-up sends. Mark as null until we add it.
  // Returning a placeholder so the UI can show "coming soon" rather than
  // a bogus number.
  return {
    name: "follow_up",
    label: "点击后的跟进节奏",
    rung: null,
    headline: "Coming soon — we don't yet track follow-up sends per click.",
    evidence: {},
    next_unlock: "Once we wire up follow-up detection, this dimension will activate.",
  };
}

async function scoreReadingRoom(repId: number, since: string): Promise<DimensionScore> {
  // Median time from inbound reply landing to the rep's outbound reply on
  // the same thread. Faster = more attentive.
  const { data: inbound } = await supabase
    .from("inbound_emails")
    .select("thread_id, created_at")
    .eq("rep_id", repId)
    .gte("created_at", since);
  if (!inbound || inbound.length === 0) {
    return {
      name: "reading_room",
      label: "回信的速度与温度",
      rung: null,
      headline: `No inbound replies received in the last ${WINDOW_DAYS} days yet.`,
      evidence: {},
      next_unlock: "Land more replies first (work on Targeting + Writing).",
    };
  }
  // For each inbound, find the next outbound by this rep on the same thread.
  const threadIds = Array.from(new Set(inbound.map((r) => r.thread_id as string).filter(Boolean)));
  const { data: outbound } = await supabase
    .from("emails")
    .select("thread_id, created_at, rep_id")
    .in("thread_id", threadIds)
    .eq("rep_id", repId);
  const outByThread = new Map<string, string[]>();
  for (const o of outbound ?? []) {
    const tid = o.thread_id as string;
    if (!outByThread.has(tid)) outByThread.set(tid, []);
    outByThread.get(tid)!.push(o.created_at as string);
  }
  for (const v of outByThread.values()) v.sort();

  const respHours: number[] = [];
  for (const inb of inbound) {
    const tid = inb.thread_id as string | null;
    if (!tid) continue;
    const outs = outByThread.get(tid) ?? [];
    const inT = new Date(inb.created_at as string).getTime();
    const next = outs.find((t) => new Date(t).getTime() > inT);
    if (next) {
      const dh = (new Date(next).getTime() - inT) / 3_600_000;
      respHours.push(dh);
    }
  }
  if (respHours.length < HONEST_N) {
    return {
      name: "reading_room",
      label: "回信的速度与温度",
      rung: null,
      headline: `Only ${respHours.length} replies-with-followup in window — need ≥${HONEST_N}.`,
      evidence: { samples: respHours.length, total_inbound: inbound.length },
      next_unlock: "Reply to more inbound to build the signal.",
    };
  }
  respHours.sort((a, b) => a - b);
  const median = respHours[Math.floor(respHours.length / 2)];
  // Cuts: 48h, 24h, 12h, 4h — lower is better.
  const r = rungInverse(median, [48, 24, 12, 4]);
  return {
    name: "reading_room",
    label: "回信的速度与温度",
    rung: r,
    headline: `Median reply time ${median.toFixed(1)}h over ${respHours.length} threads.`,
    evidence: { samples: respHours.length, median_response_hours: Math.round(median * 10) / 10 },
    next_unlock:
      r === 5
        ? null
        : r >= 3
          ? "Within 12h is the sweet spot — set a daily inbox sweep window."
          : "Try a 4h response SLA on inbound — the helper can ping you when something lands.",
  };
}

export async function computeGrowth(repId: number): Promise<GrowthSnapshot> {
  const since = windowStartIso(WINDOW_DAYS);
  const [targeting, writing, followUp, readingRoom] = await Promise.all([
    scoreTargeting(repId, since),
    scoreWriting(repId, since),
    scoreFollowUp(repId, since),
    scoreReadingRoom(repId, since),
  ]);
  const dims = [targeting, writing, followUp, readingRoom];
  const scored = dims.filter((d) => d.rung !== null) as Array<DimensionScore & { rung: 1 | 2 | 3 | 4 | 5 }>;
  const overall = scored.length === 0
    ? null
    : Math.round(scored.reduce((s, d) => s + d.rung, 0) / scored.length);

  // Pick the highest-rung dimension as strength, and the lowest as
  // opportunity. Skip null dimensions either way.
  let strength: DimensionScore | null = null;
  let opp: DimensionScore | null = null;
  for (const d of scored) {
    if (!strength || (d.rung > (strength.rung ?? 0))) strength = d;
    if (!opp || (d.rung < (opp.rung ?? 6))) opp = d;
  }
  return {
    rep_id: repId,
    window_days: WINDOW_DAYS,
    dimensions: dims,
    overall_rung: overall,
    top_strength: strength,
    top_opportunity: opp,
    computed_at: new Date().toISOString(),
  };
}
