/**
 * Lead allocator: given a mission (rep + per-pool quota), pick leads
 * from v_lead_pool and (in non-shadow mode) set assigned_rep_id.
 *
 * Stateless except for the DB calls. Pure algorithm sits in
 * pickCandidatesForPool; allocateForRep is the orchestration layer.
 */

import { supabase } from "@/lib/db";
import {
  type PerPool,
  type PoolKey,
  type PoolLeadCandidate,
  POOL_KEYS,
} from "@/lib/pool-types";

export async function pickCandidatesForPool(
  poolKey: PoolKey,
  n: number,
  directionPriority: string[],
): Promise<PoolLeadCandidate[]> {
  if (n <= 0) return [];

  const window = Math.min(Math.max(n * 3, 20), 100);

  const { data, error } = await supabase
    .from("v_lead_pool")
    .select(
      "id, person_id, author_email, author_name, lead_tier, school_tier, citation_count, h_index, matched_directions, local_score, geo, pool_key, created_at",
    )
    .eq("pool_key", poolKey)
    .order("created_at", { ascending: false })
    .limit(window);

  if (error || !data) return [];

  const candidates = data as unknown as PoolLeadCandidate[];

  const scored = candidates.map((c) => {
    let score = 0;
    if (poolKey === "strong" && directionPriority.length > 0 && c.matched_directions) {
      const dirs = c.matched_directions.split(",").map((s) => s.trim()).filter(Boolean);
      const hit = directionPriority.findIndex((p) => dirs.includes(p));
      if (hit >= 0) score += 100 + (directionPriority.length - hit);
    }
    score += (c.citation_count ?? 0) / 1000;
    return { lead: c, score };
  });

  scored.sort((a, b) => b.score - a.score || (b.lead.created_at > a.lead.created_at ? 1 : -1));

  return scored.slice(0, n).map((s) => s.lead);
}

export interface AllocateForRepInput {
  mission_id: string;
  rep_id: number;
  due_date: string;
  per_pool: PerPool;
  direction_priority: string[];
  allocator: string;
  shadow?: boolean;
  reason?: string | null;
}

export interface AllocateForRepResult {
  rep_id: number;
  mission_id: string;
  total_allocated: number;
  lead_ids: string[];
  per_pool_actual: PerPool;
  underfilled: PoolKey[];
}

export async function allocateForRep(input: AllocateForRepInput): Promise<AllocateForRepResult> {
  const allLeadIds: string[] = [];
  const perPoolActual: PerPool = { strong: 0, normal_cn: 0, normal_overseas: 0, normal_edu: 0 };
  const underfilled: PoolKey[] = [];

  for (const pk of POOL_KEYS) {
    const want = input.per_pool[pk];
    if (want <= 0) continue;

    const picks = await pickCandidatesForPool(pk, want, input.direction_priority);
    perPoolActual[pk] = picks.length;
    if (picks.length < want) underfilled.push(pk);

    if (picks.length === 0) continue;

    const ids = picks.map((p) => p.id);
    allLeadIds.push(...ids);

    // In shadow mode, write NEITHER the allocation_log row NOR the
    // pipeline_leads update. Writing the log alone would poison
    // alreadyAllocated() — the next real run would skip these missions
    // because a "fake" shadow row exists for today.
    if (!input.shadow) {
      const { error: logErr } = await supabase.from("allocation_log").insert({
        mission_id: input.mission_id,
        rep_id: input.rep_id,
        due_date: input.due_date,
        pool_key: pk,
        lead_ids: ids,
        allocator: input.allocator,
        reason: input.reason ?? null,
        notification_status: null,
      });
      if (logErr) {
        console.error(`[allocator] allocation_log insert failed for pool=${pk}: ${logErr.message}`);
      }

      const { error: updErr } = await supabase
        .from("pipeline_leads")
        .update({ assigned_rep_id: input.rep_id })
        .in("id", ids);
      if (updErr) {
        console.error(`[allocator] pipeline_leads update failed for pool=${pk}: ${updErr.message}`);
      }
    }
  }

  return {
    rep_id: input.rep_id,
    mission_id: input.mission_id,
    total_allocated: allLeadIds.length,
    lead_ids: allLeadIds,
    per_pool_actual: perPoolActual,
    underfilled,
  };
}

export async function alreadyAllocated(missionId: string, dueDate: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("allocation_log")
    .select("id")
    .eq("mission_id", missionId)
    .eq("due_date", dueDate)
    .limit(1);
  if (error) return false;
  return (data?.length || 0) > 0;
}
