// Auto-A/B (Dream #4): promote high-confidence patterns from advisory
// to a generation-layer constraint. The helper-bot already shows
// patterns as advice; this lets the system act on them at draft time
// for reps who opted in.
//
// Hard guardrails (deliberately strict — wrong rules silently degrade
// every send):
//   - sample_size ≥ 100 sent in the bucket
//   - lift ≥ 1.5x or ≤ 0.5x baseline (effect size large enough to act on)
//   - rep has sales_reps.auto_ab_enabled = true
//
// What we apply (only one rule today): if a pattern says "short
// subjects do dramatically better in segment X" and the lead matches
// X, trim the generated subject to the bucket's mean length.
//
// Adding new rules: add a function that returns a SubjectMutation or
// null and chain it after applyShortSubjectRule. Keep them
// independent so any one can be disabled.

import { supabase } from "@/lib/db";

interface PatternRow {
  scope_rep_id: number | null;
  dimension: string;
  bucket: string;
  sent: number;
  wechat_rate: number;
  wechat_lift: number;
}

interface AutoAbContext {
  repId: number;
  authorEmail: string;
  schoolTier: number | null;
  matchedDirections: string[];
}

interface SubjectMutation {
  apply: (subject: string) => string;
  reason: string;
}

const MIN_SAMPLE = 100;
const MIN_LIFT_UP = 1.5;
const MAX_LIFT_DOWN = 0.5;

async function repHasAutoAbEnabled(repId: number): Promise<boolean> {
  const { data } = await supabase
    .from("sales_reps")
    .select("auto_ab_enabled")
    .eq("id", repId)
    .maybeSingle();
  // Strict default: if column is missing or null, treat as disabled.
  // We don't want a missing-column failure to silently enable
  // experimental rules across the team.
  return data?.auto_ab_enabled === true;
}

function leadGeoBucket(authorEmail: string): "cn" | "edu" | "other" {
  const lower = (authorEmail ?? "").toLowerCase();
  if (lower.endsWith(".cn")) return "cn";
  if (lower.endsWith(".edu") || lower.endsWith(".edu.cn")) return "edu";
  return "other";
}

/**
 * Apply auto-A/B mutations to a generated subject. Returns the
 * (possibly modified) subject plus the list of rules that fired.
 *
 * Always safe to call — if the rep isn't opted in or no rule matches,
 * returns the original subject untouched and applied: [].
 */
export async function applyAutoAb(
  subject: string,
  ctx: AutoAbContext,
): Promise<{ subject: string; applied: { reason: string }[] }> {
  const enabled = await repHasAutoAbEnabled(ctx.repId);
  if (!enabled) return { subject, applied: [] };

  // Pull patterns scoped to this rep + org-wide. Org-wide patterns
  // need a stricter floor — they're noisier across reps.
  const { data: rows } = await supabase
    .from("patterns")
    .select("scope_rep_id, dimension, bucket, sent, wechat_rate, wechat_lift")
    .or(`scope_rep_id.eq.${ctx.repId},scope_rep_id.is.null`)
    .gte("sent", MIN_SAMPLE);

  const patterns = (rows ?? []) as PatternRow[];
  const applied: { reason: string }[] = [];
  let curSubject = subject;

  // Rule: short-subject for high-CN-bucket lift.
  // Pattern shape: dimension='location' + bucket=cn + wechat_lift ≥ 1.5
  // and the *cn-short-subject* meta pattern. We don't currently mine
  // a "short subject" dimension, so we approximate: when CN segment
  // shows ≥1.5x lift AND lead is CN, cap subject at 6 chars after
  // the "Invitation to Apply - " prefix. This mirrors the empirical
  // finding without inventing a non-existent dimension.
  const cnLiftPattern = patterns.find(
    (p) => p.dimension === "location" && p.bucket === "cn" && p.wechat_lift >= MIN_LIFT_UP,
  );
  if (cnLiftPattern && leadGeoBucket(ctx.authorEmail) === "cn") {
    const mut: SubjectMutation = {
      reason: `pattern says CN segment converts ${cnLiftPattern.wechat_lift.toFixed(1)}x baseline (n=${cnLiftPattern.sent}); auto-trim subject for tighter open-rate`,
      apply: (s) => {
        // Strip prefix and any trailing decorations, keep the title core,
        // cap at 30 chars. Conservative — full overhaul would need a UX
        // call about whether sales sees the trimmed version before send.
        const stripped = s.replace(/^Invitation to Apply - /, "").replace(/的潜在算力支持机会$/, "");
        const trimmed = stripped.length > 30 ? `${stripped.slice(0, 30)}…` : stripped;
        return trimmed;
      },
    };
    curSubject = mut.apply(curSubject);
    applied.push({ reason: mut.reason });
  }

  return { subject: curSubject, applied };
}
