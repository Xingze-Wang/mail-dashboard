// Lead classification (strong/normal) and sales rep assignment

import { supabase } from "@/lib/db";
import { SUPPORTED_DIRECTIONS } from "@/lib/scanner-config";

export interface AssignmentConfig {
  strong_criteria: {
    min_h_index: number;
    max_school_tier: number;
    require_overseas: boolean;
  };
  assignment: {
    strong: { rep_id: number };
    normal: { rep_ids: number[]; mode: "round_robin" };
    overseas_override?: { enabled: boolean; rep_id: number };
    category_routing?: {
      enabled: boolean;
      // Maps category name -> rep_id
      routes: Record<string, number>;
    };
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

// Round-robin counter (in-memory, resets on deploy — acceptable)
let rrIndex = 0;

/** Load assignment config from system_config table. Falls back to defaults if table doesn't exist. */
export async function getAssignmentConfig(): Promise<AssignmentConfig> {
  try {
    const { data } = await supabase
      .from("system_config")
      .select("value")
      .eq("key", "lead_assignment")
      .single();

    if (data?.value) return data.value as AssignmentConfig;
  } catch {
    // Table may not exist yet — use defaults
  }

  return {
    strong_criteria: { min_h_index: 20, max_school_tier: 2, require_overseas: true },
    assignment: {
      strong: { rep_id: 1 },
      normal: { rep_ids: [2], mode: "round_robin" },
      overseas_override: { enabled: true, rep_id: 1 },
      category_routing: {
        enabled: true,
        routes: {
          "具身智能/机器人": 1,
          "多模态/视觉生成": 1,
          "推理/架构优化": 1,
          "AI安全": 1,
          "Agent/自动化": 2,
          "科学计算/生物": 2,
          "推理/符号": 2,
          "语音/音频": 2,
          "其他": 2,
        },
      },
    },
  };
}

/** Load a sales rep by ID. Returns null if not found, inactive, or table doesn't exist. */
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

/** Load all active sales reps. Returns empty array if table doesn't exist. */
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

/** Resolve an array of matched sub-directions to their parent category.
 *  If multiple categories match, pick the one with the most hits.
 *  Returns null if no sub-direction matches any category. */
export function resolveCategory(matchedDirections: string[]): string | null {
  if (!matchedDirections || matchedDirections.length === 0) return null;

  const counts: Record<string, number> = {};
  for (const dir of matchedDirections) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    for (const [category, subs] of Object.entries(SUPPORTED_DIRECTIONS)) {
      if (subs.includes(trimmed)) {
        counts[category] = (counts[category] || 0) + 1;
      }
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

function isOverseas(email: string): boolean {
  const domain = email.split("@").pop()?.toLowerCase() ?? "";
  return !domain.endsWith(".cn");
}

/** Classify a lead as 'strong' or 'normal' based on config thresholds. */
export function classifyLead(
  config: AssignmentConfig,
  lead: {
    hIndex: number | null;
    schoolTier: number | null;
    authorEmail: string;
  },
): "strong" | "normal" {
  const { min_h_index, max_school_tier, require_overseas } = config.strong_criteria;

  if (lead.hIndex === null || lead.hIndex < min_h_index) return "normal";
  if (lead.schoolTier === null || lead.schoolTier > max_school_tier) return "normal";
  if (require_overseas && !isOverseas(lead.authorEmail)) return "normal";

  return "strong";
}

/** Pick the rep ID for a lead based on its tier, overseas status, category, and assignment config. */
export function assignRep(
  config: AssignmentConfig,
  tier: "strong" | "normal",
  authorEmail?: string,
  matchedDirections?: string[],
): number {
  // Strong leads always go to the strong rep
  if (tier === "strong") {
    return config.assignment.strong.rep_id;
  }

  // Category routing: resolve lead's category and route to owning rep
  const catRouting = config.assignment.category_routing;
  if (catRouting?.enabled && matchedDirections && matchedDirections.length > 0) {
    const category = resolveCategory(matchedDirections);
    if (category && category in catRouting.routes) {
      return catRouting.routes[category];
    }
  }

  // Overseas override: all overseas leads go to designated rep
  if (
    authorEmail &&
    config.assignment.overseas_override?.enabled &&
    isOverseas(authorEmail)
  ) {
    return config.assignment.overseas_override.rep_id;
  }

  // Normal leads: round-robin
  const repIds = config.assignment.normal.rep_ids;
  if (repIds.length === 0) return config.assignment.strong.rep_id;
  if (repIds.length === 1) return repIds[0];

  const chosen = repIds[rrIndex % repIds.length];
  rrIndex++;
  return chosen;
}
