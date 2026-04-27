// Retrain signals + proposal generation.
//
// A signal = "an event that might justify retraining a model"
// A proposal = "a summarized batch of signals + a rationale, awaiting decision"
//
// The decision can be (a) admin approves → /api/scorer/conversion-model
// retrains → signals marked consumed; (b) admin rejects → signals marked
// dismissed; (c) auto-approve if the signal weight passes a high
// threshold (later — disabled in v1 for safety).

import { supabase } from "@/lib/db";
import { getConfig } from "@/lib/system-config";

export type SignalKind = "new_wechat" | "calibration_drift" | "rep_correction" | "drift_pattern";

export interface RetrainSignal {
  id: string;
  signal_kind: SignalKind;
  payload: Record<string, unknown> | null;
  weight: number;
  status: "pending" | "consumed" | "dismissed";
  created_at: string;
}

export interface RetrainProposal {
  id: string;
  rationale: string;
  signal_count: number;
  signal_ids: string[];
  status: "pending" | "approved" | "rejected" | "expired";
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

const WEIGHTS: Record<SignalKind, number> = {
  new_wechat: 3.0,           // strongest signal — ground truth conversion
  calibration_drift: 2.0,    // model is wrong about itself
  rep_correction: 1.5,       // human telling us we got something wrong
  drift_pattern: 1.0,        // edits accumulating
};

/** Compute and emit any new signals that justify a retrain. */
export async function emitRetrainSignals(): Promise<{ emitted: number }> {
  let emitted = 0;

  // Signal 1: new wechat conversions since the last retrain.
  // Get last retrain time from active model.
  const lastModel = await getConfig<{ trained_at?: string }>("active_conversion_model");
  const lastTrainedAt = lastModel?.trained_at;

  if (lastTrainedAt) {
    const { data: newWechat } = await supabase
      .from("brief_lookups")
      .select("id, wechat_at, marked_by_rep_id")
      .eq("added_wechat", true)
      .gte("wechat_at", lastTrainedAt);
    const count = newWechat?.length ?? 0;
    if (count >= 5) {
      // Only emit if there isn't already a pending signal of this kind for the same window.
      const { data: existing } = await supabase
        .from("retrain_signals")
        .select("id")
        .eq("signal_kind", "new_wechat")
        .eq("status", "pending")
        .gte("created_at", lastTrainedAt)
        .limit(1);
      if (!existing || existing.length === 0) {
        await supabase.from("retrain_signals").insert({
          signal_kind: "new_wechat",
          payload: { count, since: lastTrainedAt },
          weight: WEIGHTS.new_wechat * Math.min(3, count / 5),
        });
        emitted++;
      }
    }
  }

  // Signal 2: rep_correction — count hard-flag corrections since last retrain.
  if (lastTrainedAt) {
    const { data: hardFlags } = await supabase
      .from("lead_corrections")
      .select("id")
      .eq("severity", "hard")
      .gte("corrected_at", lastTrainedAt);
    const count = hardFlags?.length ?? 0;
    if (count >= 3) {
      const { data: existing } = await supabase
        .from("retrain_signals")
        .select("id")
        .eq("signal_kind", "rep_correction")
        .eq("status", "pending")
        .gte("created_at", lastTrainedAt)
        .limit(1);
      if (!existing || existing.length === 0) {
        await supabase.from("retrain_signals").insert({
          signal_kind: "rep_correction",
          payload: { count, since: lastTrainedAt },
          weight: WEIGHTS.rep_correction * count,
        });
        emitted++;
      }
    }
  }

  // Signal 3: drift_pattern — count accepted prompt_drift_patterns since last retrain.
  if (lastTrainedAt) {
    const { data: drifts } = await supabase
      .from("prompt_drift_patterns")
      .select("id, status")
      .eq("status", "accepted")
      .gte("detected_at", lastTrainedAt);
    const count = drifts?.length ?? 0;
    if (count >= 2) {
      const { data: existing } = await supabase
        .from("retrain_signals")
        .select("id")
        .eq("signal_kind", "drift_pattern")
        .eq("status", "pending")
        .gte("created_at", lastTrainedAt)
        .limit(1);
      if (!existing || existing.length === 0) {
        await supabase.from("retrain_signals").insert({
          signal_kind: "drift_pattern",
          payload: { count, since: lastTrainedAt },
          weight: WEIGHTS.drift_pattern * count,
        });
        emitted++;
      }
    }
  }

  return { emitted };
}

/** Build a proposal from current pending signals. Returns null if nothing pending. */
export async function buildProposal(): Promise<RetrainProposal | null> {
  const { data: signals } = await supabase
    .from("retrain_signals")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: false });
  if (!signals || signals.length === 0) return null;

  // Skip building a proposal if there's already one pending.
  const { data: existing } = await supabase
    .from("retrain_proposals")
    .select("*")
    .eq("status", "pending")
    .limit(1);
  if (existing && existing.length > 0) return existing[0] as RetrainProposal;

  // Total weight decides whether the proposal is worth surfacing.
  const totalWeight = signals.reduce((s, r) => s + Number(r.weight ?? 0), 0);
  if (totalWeight < 4.0) return null;

  // Build a terse rationale (deterministic, no LLM call needed at this stage).
  const lines: string[] = [];
  const byKind = new Map<SignalKind, RetrainSignal[]>();
  for (const s of signals as RetrainSignal[]) {
    const arr = byKind.get(s.signal_kind) ?? [];
    arr.push(s);
    byKind.set(s.signal_kind, arr);
  }
  for (const [kind, items] of byKind) {
    const totalCount = items.reduce((sum, it) => sum + Number((it.payload as { count?: number })?.count ?? 0), 0);
    if (kind === "new_wechat") lines.push(`${totalCount} new WeChat conversions since last training`);
    else if (kind === "rep_correction") lines.push(`${totalCount} hard rep corrections since last training`);
    else if (kind === "drift_pattern") lines.push(`${totalCount} new drift patterns accepted since last training`);
    else if (kind === "calibration_drift") lines.push(`scorer calibration drifted (see payload)`);
  }
  const rationale = `Retrain proposed: ${lines.join("; ")}. Total signal weight: ${totalWeight.toFixed(1)}.`;

  const { data: created, error } = await supabase
    .from("retrain_proposals")
    .insert({
      rationale,
      signal_count: signals.length,
      signal_ids: signals.map((s) => s.id),
    })
    .select()
    .single();
  if (error) {
    console.warn("buildProposal insert failed:", error.message);
    return null;
  }
  return created as RetrainProposal;
}

/** Mark a proposal approved/rejected. Used by /api/retrain/proposal. */
export async function decideProposal(id: string, decision: "approved" | "rejected", decidedBy: string): Promise<boolean> {
  const { data: prop } = await supabase
    .from("retrain_proposals")
    .select("signal_ids")
    .eq("id", id)
    .maybeSingle();
  if (!prop) return false;

  await supabase
    .from("retrain_proposals")
    .update({ status: decision, decided_by: decidedBy, decided_at: new Date().toISOString() })
    .eq("id", id);

  const newStatus = decision === "approved" ? "consumed" : "dismissed";
  await supabase
    .from("retrain_signals")
    .update({ status: newStatus, consumed_at: new Date().toISOString(), consumed_by: decidedBy })
    .in("id", prop.signal_ids as string[]);
  return true;
}
