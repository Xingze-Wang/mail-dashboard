// Helper predictions (Dream #5).
//
// Three operations:
//   - record(): rep clicks "track this" on a helper bubble that
//     contains a falsifiable claim
//   - resolve(): cron pass that fires past target_deadline; checks
//     reality and marks correct/wrong
//   - On wrong: writes a self_critique entry to helper_learnings so
//     the helper sees its own miss next time it loads memory
//
// Loose target_event vocabulary today (kept simple):
//   "no_reply"   — claim true if NO inbound on this lead by deadline
//   "no_wechat"  — claim true if no wechat mark on this lead by deadline
//   "reply"      — claim true if inbound exists by deadline
//   "wechat"     — claim true if wechat mark exists by deadline
//
// Adding a target_event = adding one switch case in evaluate().

import { supabase } from "@/lib/db";
import { recordLearning } from "@/lib/helper-learnings";
import { judgePrediction, type JudgeVerdict } from "@/lib/bench-judge";

export type TargetEvent = "no_reply" | "no_wechat" | "reply" | "wechat";

export interface PredictionRow {
  id: string;
  rep_id: number;
  conversation_id: string | null;
  message_id: string | null;
  claim: string;
  target_event: string;
  target_lead_id: string | null;
  target_recipient: string | null;
  target_deadline: string;
  made_at: string;
  resolved_correct: boolean | null;
  resolved_at: string | null;
  resolution_note: string | null;
  judge_avg?: number | null;
  judge_at?: string | null;
  judge_verdicts?: JudgeVerdict[] | null;
}

export async function recordPrediction(input: {
  repId: number;
  conversationId?: string | null;
  messageId?: string | null;
  claim: string;
  targetEvent: TargetEvent;
  targetLeadId?: string | null;
  targetRecipient?: string | null;
  targetDeadline: Date;
}): Promise<PredictionRow | null> {
  const { data, error } = await supabase
    .from("helper_predictions")
    .insert({
      rep_id: input.repId,
      conversation_id: input.conversationId ?? null,
      message_id: input.messageId ?? null,
      claim: input.claim.trim().slice(0, 500),
      target_event: input.targetEvent,
      target_lead_id: input.targetLeadId ?? null,
      target_recipient: input.targetRecipient ?? null,
      target_deadline: input.targetDeadline.toISOString(),
    })
    .select()
    .single();
  if (error) {
    console.warn("recordPrediction failed:", error.message);
    return null;
  }
  return data as PredictionRow;
}

async function evaluate(p: PredictionRow): Promise<{ correct: boolean; note: string }> {
  // For lead-scoped predictions, look at inbound_emails (reply) or
  // brief_lookups (wechat) for that lead. Recipient match is the
  // fallback when target_lead_id is missing.
  const eventHappened = await didEventHappen(
    p.target_event as TargetEvent,
    p.target_lead_id,
    p.target_recipient,
    p.made_at,
    p.target_deadline,
  );

  switch (p.target_event) {
    case "no_reply":
      return { correct: !eventHappened, note: eventHappened ? "got a reply" : "no reply (as predicted)" };
    case "no_wechat":
      return { correct: !eventHappened, note: eventHappened ? "wechat happened" : "no wechat (as predicted)" };
    case "reply":
      return { correct: eventHappened, note: eventHappened ? "reply (as predicted)" : "no reply" };
    case "wechat":
      return { correct: eventHappened, note: eventHappened ? "wechat (as predicted)" : "no wechat" };
    default:
      return { correct: false, note: `unknown target_event: ${p.target_event}` };
  }
}

async function didEventHappen(
  ev: TargetEvent,
  leadId: string | null,
  recipient: string | null,
  since: string,
  until: string,
): Promise<boolean> {
  if (ev === "reply" || ev === "no_reply") {
    let q = supabase
      .from("inbound_emails")
      .select("id", { count: "exact", head: true })
      .gte("created_at", since)
      .lte("created_at", until);
    if (leadId) {
      // Inbound is on a thread; resolve the lead's thread first.
      const { data: lead } = await supabase
        .from("pipeline_leads")
        .select("thread_id")
        .eq("id", leadId)
        .maybeSingle();
      if (lead?.thread_id) q = q.eq("thread_id", lead.thread_id);
      else if (recipient) q = q.ilike("from", `%${recipient}%`);
      else return false;
    } else if (recipient) {
      q = q.ilike("from", `%${recipient}%`);
    } else {
      return false;
    }
    const { count } = await q;
    return (count ?? 0) > 0;
  }
  if (ev === "wechat" || ev === "no_wechat") {
    let q = supabase
      .from("brief_lookups")
      .select("id", { count: "exact", head: true })
      .eq("added_wechat", true)
      .gte("wechat_at", since)
      .lte("wechat_at", until);
    if (leadId) q = q.eq("lead_id", leadId);
    else if (recipient) q = q.ilike("query", `%${recipient}%`);
    else return false;
    const { count } = await q;
    return (count ?? 0) > 0;
  }
  return false;
}

/**
 * Cron entry point. Resolves every prediction whose target_deadline
 * has passed. Writes self_critique to helper_learnings on wrong ones
 * so the helper sees its own miss in subsequent sessions.
 */
export async function resolveDuePredictions(): Promise<{
  checked: number;
  correct: number;
  wrong: number;
}> {
  const now = new Date().toISOString();
  const { data: due } = await supabase
    .from("helper_predictions")
    .select("*")
    .is("resolved_correct", null)
    .lte("target_deadline", now)
    .limit(50);
  const rows = (due ?? []) as PredictionRow[];

  let correct = 0;
  let wrong = 0;
  for (const p of rows) {
    const { correct: ok, note } = await evaluate(p);

    // Pull lead context for the judge — much sharper rubric scoring
    // when judges can see the actual paper instead of just the claim.
    let leadContext: {
      title: string | null;
      abstract: string | null;
      schoolName: string | null;
      schoolTier: number | null;
      authorEmail: string | null;
    } | null = null;
    if (p.target_lead_id) {
      const { data: lead } = await supabase
        .from("pipeline_leads")
        .select("title, abstract, school_name, school_tier, author_email")
        .eq("id", p.target_lead_id)
        .maybeSingle();
      if (lead) {
        leadContext = {
          title: lead.title as string | null,
          abstract: lead.abstract as string | null,
          schoolName: lead.school_name as string | null,
          schoolTier: lead.school_tier as number | null,
          authorEmail: lead.author_email as string | null,
        };
      }
    }

    // Run the 3-judge ensemble on reasoning quality. Costs ~3 LLM
    // calls per prediction; cron is daily-low-volume so this is fine.
    let verdicts: JudgeVerdict[] = [];
    let avg: number | null = null;
    try {
      verdicts = await judgePrediction({
        claim: p.claim,
        targetEvent: p.target_event,
        outcomeNote: note,
        outcomeCorrect: ok,
        leadContext,
      });
      const successful = verdicts.filter((v) => v.error === null);
      avg = successful.length > 0
        ? successful.reduce((s, v) => s + v.score_0_10, 0) / successful.length
        : null;
    } catch (err) {
      // Judge failure is non-fatal — outcome resolution is still
      // recorded. Self-critique falls back to outcome-only.
      console.warn("judgePrediction failed for", p.id, err);
    }

    await supabase
      .from("helper_predictions")
      .update({
        resolved_correct: ok,
        resolved_at: now,
        resolution_note: note,
        judge_avg: avg,
        judge_at: avg != null ? now : null,
        judge_verdicts: verdicts.length > 0 ? verdicts : null,
      })
      .eq("id", p.id);

    if (ok) {
      correct++;
      // Right-by-accident path: outcome correct but judge thought the
      // reasoning was lazy. The helper should LOWER confidence here,
      // not raise it — the world rewarded a bad bet.
      if (avg != null && avg < 5) {
        await recordLearning({
          scope_rep_id: p.rep_id,
          kind: "self_critique",
          body: `Predicted "${p.claim.slice(0, 200)}" and got it right, but judges (avg ${avg.toFixed(1)}/10) flagged the reasoning as thin. Don't trust this kind of pattern-matching going forward.`,
          confidence: 0.5,
          evidence: { prediction_id: p.id, judge_avg: avg, outcome: note },
        });
      }
    } else {
      wrong++;
      // Wrong outcome — strength of self-critique depends on whether
      // judges thought the reasoning was sound.
      if (avg == null) {
        // No judge run (failure) — fall back to outcome-only critique.
        await recordLearning({
          scope_rep_id: p.rep_id,
          kind: "self_critique",
          body: `Predicted "${p.claim.slice(0, 200)}" — but ${note}. Lower confidence on this kind of judgment.`,
          confidence: 0.6,
          evidence: { prediction_id: p.id, outcome: note },
        });
      } else if (avg >= 7) {
        // Wrong-but-reasoning-was-right: world surprised us, soft critique.
        await recordLearning({
          scope_rep_id: p.rep_id,
          kind: "self_critique",
          body: `Predicted "${p.claim.slice(0, 200)}" with sound reasoning (judges ${avg.toFixed(1)}/10), but ${note}. Counter-example to add to the model — keep watching for this kind of edge case.`,
          confidence: 0.45,
          evidence: { prediction_id: p.id, judge_avg: avg, outcome: note },
        });
      } else {
        // Wrong outcome AND lazy reasoning — strong critique.
        await recordLearning({
          scope_rep_id: p.rep_id,
          kind: "self_critique",
          body: `Predicted "${p.claim.slice(0, 200)}" — wrong (${note}) AND judges (${avg.toFixed(1)}/10) flagged the reasoning as thin. Stop making this kind of claim without specific evidence.`,
          confidence: 0.75,
          evidence: { prediction_id: p.id, judge_avg: avg, outcome: note },
        });
      }
    }
  }
  return { checked: rows.length, correct, wrong };
}
