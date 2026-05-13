/**
 * Type definitions for the shared-pool allocation system.
 * Imported by allocator.ts, quota-store.ts, and route handlers.
 */

export type PoolKey = "strong" | "normal_cn" | "normal_overseas" | "normal_edu";

export const POOL_KEYS: readonly PoolKey[] = [
  "strong",
  "normal_cn",
  "normal_overseas",
  "normal_edu",
] as const;

export interface PerPool {
  strong: number;
  normal_cn: number;
  normal_overseas: number;
  normal_edu: number;
}

export const ZERO_PER_POOL: PerPool = {
  strong: 0,
  normal_cn: 0,
  normal_overseas: 0,
  normal_edu: 0,
};

export interface RepDailyQuota {
  rep_id: number;
  per_pool: PerPool;
  direction_priority: string[];
  updated_by_rep_id: number | null;
  updated_at: string;
}

export interface RepDailyQuotaOverride {
  id: string;
  rep_id: number;
  due_date: string; // ISO date
  per_pool: PerPool;
  reason: string | null;
  created_by_rep_id: number | null;
  created_at: string;
}

export interface AllocationLogRow {
  id: string;
  mission_id: string | null;
  rep_id: number;
  due_date: string;
  pool_key: PoolKey;
  lead_ids: string[];
  allocator: string; // 'cron' | 'admin:{rep_id}'
  reason: string | null;
  notification_status: "sent" | "failed" | "skipped_no_lark" | null;
  notification_sent_at: string | null;
  created_at: string;
}

export interface PoolLeadCandidate {
  id: string;
  person_id: string | null;
  author_email: string;
  author_name: string | null;
  lead_tier: "strong" | "normal";
  school_tier: number | null;
  citation_count: number | null;
  h_index: number | null;
  matched_directions: string | null;
  local_score: number | null;
  geo: "cn" | "edu" | "other";
  pool_key: PoolKey;
  created_at: string;
}

export function sumPerPool(p: PerPool): number {
  return p.strong + p.normal_cn + p.normal_overseas + p.normal_edu;
}

export function normalizePerPool(raw: unknown): PerPool {
  if (!raw || typeof raw !== "object") return { ...ZERO_PER_POOL };
  const r = raw as Record<string, unknown>;
  const num = (k: string) => {
    const v = r[k];
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
  };
  return {
    strong: num("strong"),
    normal_cn: num("normal_cn"),
    normal_overseas: num("normal_overseas"),
    normal_edu: num("normal_edu"),
  };
}
