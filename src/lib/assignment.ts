// Lead classification (strong/normal) and sales rep assignment.
//
// Rules (binding spec — see SALES_RULES.md):
//   Tier:
//     Strong if:
//       schoolTier ∈ [1, max_school_tier]   (verified top school always wins)
//       OR citationCount > min_citation AND schoolTier is verified (non-null)
//       OR citationCount > min_citation_unverified  (high bar when school unknown)
//     Otherwise Normal.
//   Assignment (in order, first match wins):
//     1. Strong → strong rep (Leo)
//     2. Normal + matched category has a configured rep → that rep
//     3. Normal + overseas (email NOT .cn) → overseas rep (Ethan)
//     4. Normal + domestic (email .cn) → domestic rep (Chenyu)

import { supabase } from "@/lib/db";
import { SUPPORTED_DIRECTIONS } from "@/lib/scanner-config";

export interface AssignmentConfig {
  strong_criteria: {
    min_citation: number;
    min_citation_unverified: number;
    max_school_tier: number;
    min_local_score: number;
  };
  assignment: {
    strong: { rep_id: number };
    overseas: { rep_id: number };
    domestic: { rep_id: number };
    /** Optional per-sub-direction override for normal-tier leads. Keys are
     *  values from SUPPORTED_DIRECTIONS (e.g. "4D重建生成"). */
    by_direction?: Record<string, number>;
  };
}

export interface SalesRep {
  id: number;
  name: string;
  sender_email: string;
  sender_name: string;
  wechat_id: string;
  active: boolean;
}

const DEFAULT_REP_IDS = {
  leo: 1,
  chenyu: 2,
  ethan: 3,
} as const;

export async function getAssignmentConfig(): Promise<AssignmentConfig> {
  try {
    const { data } = await supabase
      .from("system_config")
      .select("value")
      .eq("key", "lead_assignment")
      .single();
    if (data?.value) return normalizeConfig(data.value);
  } catch {
    // Table may not exist yet
  }
  return defaultConfig();
}

/** Sub-directions that always route to Leo when normal-tier (4D Gaussian /
 *  embodied / world-model / memory family). Keep in sync with the values
 *  in SUPPORTED_DIRECTIONS. */
const LEO_DEFAULT_DIRECTIONS = [
  // 具身智能/机器人 — entire category
  "具身导航感知", "多模态具身大模型", "模块化力控关节",
  "场景孪生仿真", "工业具身模仿学习", "自动驾驶",
  "世界模型+VLA", "连续体机械臂", "端侧机器人推理",
  "视频策略表征", "1 bit 量化VLA模型",
  "长程灵巧操作", "具身3D空间理解",
  "化工精密操作机器人", "实验室语音交互机器人",
  "多模态无人机交互", "农业场景具身模型",
  "记忆驱动世界模型",
  // 多模态/视觉生成 — 4D / 3D / world-model subset
  "4D重建生成", "3D资产生成", "3D视频生成",
  "多模态世界模型", "通用世界模拟模型", "低显存实时3D重建",
];

function defaultLeoDirections(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of LEO_DEFAULT_DIRECTIONS) out[d] = DEFAULT_REP_IDS.leo;
  return out;
}

export function defaultConfig(): AssignmentConfig {
  return {
    strong_criteria: {
      // New composite scheme: tier-1 +2000, tier-2 +1000, score-bonus +500.
      // Bar at 5000 effective citations means:
      //   tier-1 author needs 3000+ raw cites
      //   tier-2 author needs 4000+ raw cites
      //   unknown school needs 5000+ raw cites
      min_citation: 5000,
      min_citation_unverified: 5000,
      max_school_tier: 2,
      min_local_score: 0.85,
    },
    assignment: {
      strong: { rep_id: DEFAULT_REP_IDS.leo },
      overseas: { rep_id: DEFAULT_REP_IDS.ethan },
      domestic: { rep_id: DEFAULT_REP_IDS.chenyu },
      by_direction: defaultLeoDirections(),
    },
  };
}

function normalizeConfig(raw: unknown): AssignmentConfig {
  const def = defaultConfig();
  if (!raw || typeof raw !== "object") return def;
  const r = raw as Record<string, unknown>;

  const sc = (r.strong_criteria as Record<string, unknown> | undefined) ?? {};
  const min_citation =
    typeof sc.min_citation === "number" ? sc.min_citation : def.strong_criteria.min_citation;
  const min_local_score =
    typeof sc.min_local_score === "number" ? sc.min_local_score : def.strong_criteria.min_local_score;
  const min_citation_unverified =
    typeof sc.min_citation_unverified === "number"
      ? sc.min_citation_unverified
      : def.strong_criteria.min_citation_unverified;
  const max_school_tier =
    typeof sc.max_school_tier === "number" ? sc.max_school_tier : def.strong_criteria.max_school_tier;

  const a = (r.assignment as Record<string, unknown> | undefined) ?? {};
  const strongRep =
    (a.strong as { rep_id?: number } | undefined)?.rep_id ?? def.assignment.strong.rep_id;

  let overseasRep = (a.overseas as { rep_id?: number } | undefined)?.rep_id;
  let domesticRep = (a.domestic as { rep_id?: number } | undefined)?.rep_id;

  // Legacy migration paths (kept so old rows still parse)
  if (overseasRep === undefined) {
    const ov = a.overseas_override as { enabled?: boolean; rep_id?: number } | undefined;
    if (ov?.enabled && typeof ov.rep_id === "number") overseasRep = ov.rep_id;
  }
  if (domesticRep === undefined) {
    const normal = a.normal as { rep_ids?: unknown } | undefined;
    if (Array.isArray(normal?.rep_ids) && normal!.rep_ids.length > 0) {
      const first = (normal!.rep_ids as unknown[]).find((x) => typeof x === "number");
      if (typeof first === "number") domesticRep = first;
    }
  }

  // Per-direction routing — { "4D重建生成": 1, "具身导航感知": 1, ... }
  const byDirRaw = a.by_direction as Record<string, unknown> | undefined;
  const by_direction: Record<string, number> = {};
  if (byDirRaw && typeof byDirRaw === "object") {
    for (const [dir, repId] of Object.entries(byDirRaw)) {
      if (typeof repId === "number") by_direction[dir] = repId;
    }
  }

  // Legacy by_category → migrate by exploding to all sub-directions
  if (Object.keys(by_direction).length === 0) {
    const byCatRaw = a.by_category as Record<string, unknown> | undefined;
    if (byCatRaw && typeof byCatRaw === "object") {
      for (const [cat, repId] of Object.entries(byCatRaw)) {
        if (typeof repId !== "number") continue;
        const subs = SUPPORTED_DIRECTIONS[cat] ?? [];
        for (const sub of subs) by_direction[sub] = repId;
      }
    }
  }

  return {
    strong_criteria: { min_citation, min_citation_unverified, max_school_tier, min_local_score },
    assignment: {
      strong: { rep_id: strongRep },
      overseas: { rep_id: overseasRep ?? def.assignment.overseas.rep_id },
      domestic: { rep_id: domesticRep ?? def.assignment.domestic.rep_id },
      by_direction,
    },
  };
}

export async function getRep(id: number): Promise<SalesRep | null> {
  try {
    const { data } = await supabase
      .from("sales_reps")
      .select("*")
      .eq("id", id)
      .eq("active", true)
      .single();
    return data as SalesRep | null;
  } catch {
    return null;
  }
}

export async function getAllReps(): Promise<SalesRep[]> {
  try {
    const { data } = await supabase
      .from("sales_reps")
      .select("*")
      .eq("active", true)
      .order("id");
    return (data ?? []) as SalesRep[];
  } catch {
    return [];
  }
}

/** Resolve matched sub-directions to their parent category (most-frequent wins). */
export function resolveCategory(matchedDirections: string[] | string | null | undefined): string | null {
  const list =
    typeof matchedDirections === "string"
      ? matchedDirections.split(",").map((s) => s.trim()).filter(Boolean)
      : Array.isArray(matchedDirections)
        ? matchedDirections
        : [];
  if (list.length === 0) return null;

  const counts: Record<string, number> = {};
  for (const dir of list) {
    for (const [category, subs] of Object.entries(SUPPORTED_DIRECTIONS)) {
      if (subs.includes(dir)) counts[category] = (counts[category] || 0) + 1;
    }
  }

  let best: string | null = null;
  let bestCount = 0;
  for (const [cat, count] of Object.entries(counts)) {
    if (count > bestCount) {
      best = cat;
      bestCount = count;
    }
  }
  return best;
}

function isOverseas(email: string | null | undefined): boolean {
  if (!email) return false;
  const domain = email.split("@").pop()?.toLowerCase() ?? "";
  return !domain.endsWith(".cn");
}

/**
 * Strong if:
 *   - school_tier ∈ [1, max_school_tier]                              (verified top school)
 *   - OR citation_count > min_citation AND school_tier is verified    (verified non-top + high cite)
 *   - OR citation_count > min_citation_unverified                      (school unknown — needs higher bar)
 */
/**
 * Strong = "senior researcher" (top school OR many citations).
 * NOT a function of paper quality (`local_score`) — that's a separate axis
 * about whether this particular paper is a good outreach target.
 *
 *   Strong if any of:
 *     - schoolTier ∈ [1, max_school_tier]                          (顶校)
 *     - schoolTier verified AND cite > min_citation                (verified non-top + high cite)
 *     - schoolTier unknown AND cite > min_citation_unverified      (unknown school, very high cite)
 */
/**
 * Composite "strength score" classifier:
 *   - Tier-1 school adds 2000 citation-equivalent (top schools = strong prior)
 *   - Tier-2 school adds 1000
 *   - Tier-3 / unknown adds 0
 *   - high local_score (>= min_local_score) adds 500
 *   - effective_citations = real citations + school bonus + score bonus
 *   - strong if effective_citations > min_citation (default 5000)
 *
 * This means: a top-school PhD with 3000 cites is strong (3000+2000=5000),
 * a tier-2 unknown with 4500 cites is strong (4500+1000=5500), an
 * unknown-school researcher needs 5000 raw cites alone. Score >= threshold
 * is just a small +500 — it doesn't make a no-cite no-school person strong.
 *
 * The 4 config knobs are still honored for backward compat:
 *   - min_citation                → strong threshold (default 5000)
 *   - max_school_tier (1 or 2)    → max tier that gets a bonus
 *   - min_citation_unverified     → still respected as a fallback path
 *                                   (raw cites alone with no school info)
 *   - min_local_score             → triggers the +500 score bonus
 */
const TIER_CITATION_BONUS: Record<number, number> = { 1: 2000, 2: 1000, 3: 0 };
const HIGH_SCORE_BONUS = 500;

export function classifyLead(
  config: AssignmentConfig,
  lead: {
    citationCount?: number | null;
    /** Legacy alias — ignored by current rule. */
    hIndex?: number | null;
    schoolTier: number | null;
    authorEmail?: string;
    localScore?: number | null;
  },
): "strong" | "normal" {
  const { min_citation, min_citation_unverified, max_school_tier, min_local_score } = config.strong_criteria;
  const tier = lead.schoolTier;
  const cite = lead.citationCount ?? 0;
  const score = lead.localScore ?? 0;

  // School bonus only applies up to max_school_tier (configurable cap so
  // admin can disable tier-2 bonus by setting max_school_tier=1).
  let schoolBonus = 0;
  if (tier !== null && tier !== undefined && tier <= max_school_tier) {
    schoolBonus = TIER_CITATION_BONUS[tier] ?? 0;
  }

  // Score bonus — only fires when sufficiently high. Doesn't lift a zero-cite
  // unknown-school person to strong by itself.
  const scoreBonus = score >= min_local_score ? HIGH_SCORE_BONUS : 0;

  const effective = cite + schoolBonus + scoreBonus;
  if (effective > min_citation) return "strong";

  // Legacy fallback: pure-citations path for the no-school-info case
  // (kept so changing the bonus model doesn't accidentally drop a known-
  // famous unknown-school researcher).
  if ((tier === null || tier === undefined) && cite > min_citation_unverified) return "strong";

  return "normal";
}

function normalizeDirections(input: string[] | string | null | undefined): string[] {
  if (typeof input === "string") return input.split(",").map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(input)) return input.filter((s): s is string => typeof s === "string" && s.length > 0);
  return [];
}

/**
 * Pick the rep:
 *   strong → strong rep
 *   normal → first matched_direction with an explicit owner → that rep
 *          → otherwise overseas/domestic by email geography
 */
export function assignRep(
  config: AssignmentConfig,
  tier: "strong" | "normal",
  authorEmail?: string | null,
  matchedDirections?: string[] | string | null,
): number {
  if (tier === "strong") return config.assignment.strong.rep_id;

  const dirs = normalizeDirections(matchedDirections);
  const byDir = config.assignment.by_direction;
  if (byDir) {
    for (const d of dirs) {
      if (typeof byDir[d] === "number") return byDir[d];
    }
  }

  return isOverseas(authorEmail)
    ? config.assignment.overseas.rep_id
    : config.assignment.domestic.rep_id;
}
