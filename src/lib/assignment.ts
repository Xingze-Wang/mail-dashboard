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
  };
  assignment: {
    strong: { rep_id: number };
    overseas: { rep_id: number };
    domestic: { rep_id: number };
    /** Optional per-category override for normal-tier leads. */
    by_category?: Record<string, number>;
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

export function defaultConfig(): AssignmentConfig {
  return {
    strong_criteria: {
      min_citation: 2000,
      min_citation_unverified: 5000,
      max_school_tier: 2,
    },
    assignment: {
      strong: { rep_id: DEFAULT_REP_IDS.leo },
      overseas: { rep_id: DEFAULT_REP_IDS.ethan },
      domestic: { rep_id: DEFAULT_REP_IDS.chenyu },
      by_category: {},
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

  // Category routing — { "具身智能/机器人": 2, ... }
  const byCatRaw = a.by_category as Record<string, unknown> | undefined;
  const by_category: Record<string, number> = {};
  if (byCatRaw && typeof byCatRaw === "object") {
    for (const [cat, repId] of Object.entries(byCatRaw)) {
      if (typeof repId === "number") by_category[cat] = repId;
    }
  }

  return {
    strong_criteria: { min_citation, min_citation_unverified, max_school_tier },
    assignment: {
      strong: { rep_id: strongRep },
      overseas: { rep_id: overseasRep ?? def.assignment.overseas.rep_id },
      domestic: { rep_id: domesticRep ?? def.assignment.domestic.rep_id },
      by_category,
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
export function classifyLead(
  config: AssignmentConfig,
  lead: {
    citationCount?: number | null;
    /** Legacy alias — ignored by current rule. */
    hIndex?: number | null;
    schoolTier: number | null;
    authorEmail?: string;
  },
): "strong" | "normal" {
  const { min_citation, min_citation_unverified, max_school_tier } = config.strong_criteria;
  const tier = lead.schoolTier;
  const cite = lead.citationCount ?? 0;

  if (tier !== null && tier !== undefined && tier >= 1 && tier <= max_school_tier) return "strong";
  if (tier !== null && tier !== undefined && cite > min_citation) return "strong";
  if ((tier === null || tier === undefined) && cite > min_citation_unverified) return "strong";

  return "normal";
}

/**
 * Pick the rep:
 *   strong → strong rep
 *   normal → category map (if matched) → overseas/domestic by email
 */
export function assignRep(
  config: AssignmentConfig,
  tier: "strong" | "normal",
  authorEmail?: string | null,
  matchedDirections?: string[] | string | null,
): number {
  if (tier === "strong") return config.assignment.strong.rep_id;

  const category = resolveCategory(matchedDirections ?? null);
  const byCat = config.assignment.by_category;
  if (category && byCat && typeof byCat[category] === "number") {
    return byCat[category];
  }

  return isOverseas(authorEmail)
    ? config.assignment.overseas.rep_id
    : config.assignment.domestic.rep_id;
}
