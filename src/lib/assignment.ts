// Lead classification (strong/normal) and sales rep assignment

import { supabase } from "@/lib/db";

export interface AssignmentConfig {
  strong_criteria: {
    min_h_index: number;
    max_school_tier: number;
    require_overseas: boolean;
  };
  assignment: {
    strong: { rep_id: number };
    normal: { rep_ids: number[]; mode: "round_robin" };
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
    assignment: { strong: { rep_id: 1 }, normal: { rep_ids: [1], mode: "round_robin" } },
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

/** Pick the rep ID for a lead based on its tier and assignment config. */
export function assignRep(
  config: AssignmentConfig,
  tier: "strong" | "normal",
): number {
  if (tier === "strong") {
    return config.assignment.strong.rep_id;
  }

  const repIds = config.assignment.normal.rep_ids;
  if (repIds.length === 0) return config.assignment.strong.rep_id;
  if (repIds.length === 1) return repIds[0];

  const chosen = repIds[rrIndex % repIds.length];
  rrIndex++;
  return chosen;
}
