import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { allocateForRep, alreadyAllocated } from "@/lib/allocator";
import { getEffectiveQuota } from "@/lib/quota-store";
import { sumPerPool, normalizePerPool, PerPool, PoolKey } from "@/lib/pool-types";
import { requireSession } from "@/lib/auth-helpers";

export const preferredRegion = ["hkg1"];
export const maxDuration = 300;

interface RunResult {
  due_date: string;
  shadow: boolean;
  per_rep: Array<{
    rep_id: number;
    rep_name: string;
    mission_id: string | null;
    skipped_reason?: string;
    total_allocated?: number;
    per_pool_actual?: PerPool;
    underfilled?: string[];
  }>;
}

async function runAllocation(shadow: boolean, allocator: string): Promise<RunResult> {
  const today = new Date().toISOString().slice(0, 10);
  const result: RunResult = { due_date: today, shadow, per_rep: [] };

  const missions = await supabase
    .from("missions")
    .select("id, rep_id, target, scope")
    .eq("due_date", today)
    .eq("kind", "send")
    .eq("status", "active");
  if (missions.error) throw new Error(`missions query failed: ${missions.error.message}`);

  const repIds = (missions.data || []).map((m) => m.rep_id);
  const reps = repIds.length
    ? await supabase.from("sales_reps").select("id, name").in("id", repIds)
    : { data: [] as Array<{ id: number; name: string }>, error: null };
  const nameById = new Map((reps.data || []).map((r) => [r.id, r.name]));

  for (const m of missions.data || []) {
    const entry: RunResult["per_rep"][number] = {
      rep_id: m.rep_id,
      rep_name: nameById.get(m.rep_id) ?? `rep_${m.rep_id}`,
      mission_id: m.id as string,
    };

    if (await alreadyAllocated(m.id as string, today)) {
      entry.skipped_reason = "already_allocated";
      result.per_rep.push(entry);
      continue;
    }

    let perPool: { strong: number; normal_cn: number; normal_overseas: number; normal_edu: number } | null = null;
    let directionPriority: string[] = [];

    const scope = m.scope as { per_pool?: unknown; direction_priority?: unknown } | null;
    if (scope && typeof scope === "object" && scope.per_pool) {
      perPool = normalizePerPool(scope.per_pool);
      if (Array.isArray(scope.direction_priority)) {
        directionPriority = scope.direction_priority.filter((s): s is string => typeof s === "string");
      }
    } else {
      const q = await getEffectiveQuota(m.rep_id, today);
      perPool = q.per_pool;
      directionPriority = q.direction_priority;
    }

    if (!perPool || sumPerPool(perPool) === 0) {
      entry.skipped_reason = "zero_quota";
      result.per_rep.push(entry);
      continue;
    }

    const r = await allocateForRep({
      mission_id: m.id as string,
      rep_id: m.rep_id,
      due_date: today,
      per_pool: perPool,
      direction_priority: directionPriority,
      allocator,
      shadow,
    });
    entry.total_allocated = r.total_allocated;
    entry.per_pool_actual = r.per_pool_actual;
    entry.underfilled = r.underfilled;
    result.per_rep.push(entry);
  }

  if (!shadow) {
    const { notifyRepOfAllocation } = await import("@/lib/allocation-notifier");
    for (const entry of result.per_rep) {
      if (!entry.total_allocated || entry.total_allocated === 0) continue;
      if (entry.skipped_reason) continue;
      await notifyRepOfAllocation({
        rep_id: entry.rep_id,
        due_date: result.due_date,
        per_pool_actual: entry.per_pool_actual as PerPool,
        underfilled: (entry.underfilled || []) as PoolKey[],
        total_allocated: entry.total_allocated,
      }).catch((e) => {
        console.error(`[allocate-leads] notify failed for rep ${entry.rep_id}:`, e);
      });
    }
  }

  return result;
}

/** GET — cron entry point. Auth: Bearer $CRON_SECRET. */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") || "";
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (!process.env.CRON_SECRET || auth !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const shadow = process.env.ALLOCATE_LEADS_SHADOW === "true";
  const result = await runAllocation(shadow, "cron");
  return NextResponse.json(result);
}

/** POST — admin trigger. */
export async function POST(req: NextRequest) {
  const session = await requireSession(req);
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "admin only" }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  const shadow = body.shadow === true;
  const result = await runAllocation(shadow, `admin:${session.repId}`);
  return NextResponse.json(result);
}
