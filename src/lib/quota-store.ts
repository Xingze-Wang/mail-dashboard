/**
 * Read/write helpers for rep_daily_quotas and rep_daily_quotas_override.
 * The "effective" quota for (rep, date) is: override row if present, else standing quota.
 */

import { supabase } from "@/lib/db";
import {
  type PerPool,
  type RepDailyQuota,
  normalizePerPool,
  ZERO_PER_POOL,
} from "@/lib/pool-types";

export interface EffectiveQuota {
  rep_id: number;
  per_pool: PerPool;
  direction_priority: string[];
  source: "standing" | "override";
}

export async function getEffectiveQuota(
  repId: number,
  dueDate: string,
): Promise<EffectiveQuota> {
  // Override path — but ignore "marker" overrides whose reason starts with "_"
  // (used by cron deduplication, see plan T16.5).
  const ov = await supabase
    .from("rep_daily_quotas_override")
    .select("per_pool, reason")
    .eq("rep_id", repId)
    .eq("due_date", dueDate)
    .maybeSingle();
  if (ov.data?.per_pool && !String(ov.data.reason || "").startsWith("_")) {
    return {
      rep_id: repId,
      per_pool: normalizePerPool(ov.data.per_pool),
      direction_priority: [],
      source: "override",
    };
  }

  const st = await supabase
    .from("rep_daily_quotas")
    .select("per_pool, direction_priority")
    .eq("rep_id", repId)
    .maybeSingle();
  if (st.data) {
    return {
      rep_id: repId,
      per_pool: normalizePerPool(st.data.per_pool),
      direction_priority: Array.isArray(st.data.direction_priority)
        ? st.data.direction_priority.filter((s): s is string => typeof s === "string")
        : [],
      source: "standing",
    };
  }

  return {
    rep_id: repId,
    per_pool: { ...ZERO_PER_POOL },
    direction_priority: [],
    source: "standing",
  };
}

export async function getAllEffectiveQuotas(dueDate: string): Promise<EffectiveQuota[]> {
  const reps = await supabase
    .from("sales_reps")
    .select("id")
    .eq("active", true);
  if (reps.error || !reps.data) return [];
  return Promise.all(reps.data.map((r) => getEffectiveQuota(r.id, dueDate)));
}

export async function setStandingQuota(
  repId: number,
  input: {
    per_pool: PerPool;
    direction_priority?: string[];
    updated_by_rep_id: number | null;
  },
): Promise<void> {
  const { error } = await supabase.from("rep_daily_quotas").upsert(
    {
      rep_id: repId,
      per_pool: normalizePerPool(input.per_pool),
      direction_priority: input.direction_priority ?? [],
      updated_by_rep_id: input.updated_by_rep_id,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "rep_id" },
  );
  if (error) throw new Error(`setStandingQuota failed: ${error.message}`);
}

export async function setOverride(
  repId: number,
  dueDate: string,
  input: {
    per_pool: PerPool;
    reason?: string | null;
    created_by_rep_id: number | null;
  },
): Promise<void> {
  const { error } = await supabase.from("rep_daily_quotas_override").upsert(
    {
      rep_id: repId,
      due_date: dueDate,
      per_pool: normalizePerPool(input.per_pool),
      reason: input.reason ?? null,
      created_by_rep_id: input.created_by_rep_id,
    },
    { onConflict: "rep_id,due_date" },
  );
  if (error) throw new Error(`setOverride failed: ${error.message}`);
}

export async function listStandingQuotas(): Promise<RepDailyQuota[]> {
  const { data, error } = await supabase
    .from("rep_daily_quotas")
    .select("*")
    .order("rep_id");
  if (error || !data) return [];
  return data.map((r) => ({
    ...r,
    per_pool: normalizePerPool(r.per_pool),
    direction_priority: Array.isArray(r.direction_priority) ? r.direction_priority : [],
  }));
}
