// Lead classification (strong/normal) and sales rep assignment.
//
// Rules (binding spec — see SALES_RULES.md):
//   Tier:
//     Strong if citation_count > 2000 OR school_tier ∈ {1, 2}
//     Otherwise Normal.
//   Assignment:
//     Strong            → Leo
//     Normal + overseas → Ethan   (email domain does NOT end with .cn)
//     Normal + domestic → Chenyu  (email domain ends with .cn)
//
// No more round-robin, no more category routing. Flat 3-way decision.

import { supabase } from "@/lib/db";
import { SUPPORTED_DIRECTIONS } from "@/lib/scanner-config";

export interface AssignmentConfig {
  strong_criteria: {
    min_citation: number;
    max_school_tier: number;
  };
  assignment: {
    strong: { rep_id: number };
    overseas: { rep_id: number };
    domestic: { rep_id: number };
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

// Default rep IDs after `migrations/003-add-ethan.sql` is applied.
// Leo is seeded with id=1; Chenyu and Ethan get the next two SERIAL ids.
// If your DB ordering differs, override the defaults in /settings.
const DEFAULT_REP_IDS = {
  leo: 1,
  chenyu: 2,
  ethan: 3,
} as const;

/** Load assignment config from system_config table. Falls back to defaults if absent. */
export async function getAssignmentConfig(): Promise<AssignmentConfig> {
  try {
    const { data } = await supabase
      .from("system_config")
      .select("value")
      .eq("key", "lead_assignment")
      .single();

    if (data?.value) return normalizeConfig(data.value);
  } catch {
    // Table may not exist yet — use defaults
  }

  return defaultConfig();
}

export function defaultConfig(): AssignmentConfig {
  return {
    strong_criteria: { min_citation: 2000, max_school_tier: 2 },
    assignment: {
      strong: { rep_id: DEFAULT_REP_IDS.leo },
      overseas: { rep_id: DEFAULT_REP_IDS.ethan },
      domestic: { rep_id: DEFAULT_REP_IDS.chenyu },
    },
  };
}

/** Migrate older config shapes (h-index based, round-robin, category routing)
 *  forward to the new flat tier+geo shape. Anything unrecognized falls back
 *  to `defaultConfig()`. */
function normalizeConfig(raw: unknown): AssignmentConfig {
  const def = defaultConfig();
  if (!raw || typeof raw !== "object") return def;
  const r = raw as Record<string, unknown>;

  const sc = (r.strong_criteria as Record<string, unknown> | undefined) ?? {};
  const min_citation =
    typeof sc.min_citation === "number"
      ? sc.min_citation
      : def.strong_criteria.min_citation;
  const max_school_tier =
    typeof sc.max_school_tier === "number"
      ? sc.max_school_tier
      : def.strong_criteria.max_school_tier;

  const a = (r.assignment as Record<string, unknown> | undefined) ?? {};
  const strongRep =
    (a.strong as { rep_id?: number } | undefined)?.rep_id ??
    def.assignment.strong.rep_id;

  // New shape
  let overseasRep = (a.overseas as { rep_id?: number } | undefined)?.rep_id;
  let domesticRep = (a.domestic as { rep_id?: number } | undefined)?.rep_id;

  // Legacy shape: overseas_override + normal.rep_ids (round-robin).
  if (overseasRep === undefined) {
    const ov = a.overseas_override as
      | { enabled?: boolean; rep_id?: number }
      | undefined;
    if (ov?.enabled && typeof ov.rep_id === "number") overseasRep = ov.rep_id;
  }
  if (domesticRep === undefined) {
    const normal = a.normal as { rep_ids?: unknown } | undefined;
    if (Array.isArray(normal?.rep_ids) && normal!.rep_ids.length > 0) {
      const first = (normal!.rep_ids as unknown[]).find(
        (x) => typeof x === "number",
      );
      if (typeof first === "number") domesticRep = first;
    }
  }

  return {
    strong_criteria: { min_citation, max_school_tier },
    assignment: {
      strong: { rep_id: strongRep },
      overseas: { rep_id: overseasRep ?? def.assignment.overseas.rep_id },
      domestic: { rep_id: domesticRep ?? def.assignment.domestic.rep_id },
    },
  };
}

/** Load a single active sales rep by ID. */
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

/** Load all active sales reps. */
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
 *  Used for display + filtering only — routing no longer depends on it. */
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

function isOverseas(email: string | null | undefined): boolean {
  if (!email) return false;
  const domain = email.split("@").pop()?.toLowerCase() ?? "";
  return !domain.endsWith(".cn");
}

/** Classify a lead as 'strong' or 'normal'.
 *  Strong if: citationCount > min_citation OR schoolTier ∈ [1, max_school_tier].
 *  When data is missing, falls through to 'normal'. */
export function classifyLead(
  config: AssignmentConfig,
  lead: {
    citationCount?: number | null;
    /** Legacy alias — ignored by current rule, accepted so older callers compile. */
    hIndex?: number | null;
    schoolTier: number | null;
    authorEmail?: string;
  },
): "strong" | "normal" {
  const { min_citation, max_school_tier } = config.strong_criteria;

  if ((lead.citationCount ?? 0) > min_citation) return "strong";
  if (
    lead.schoolTier !== null &&
    lead.schoolTier !== undefined &&
    lead.schoolTier >= 1 &&
    lead.schoolTier <= max_school_tier
  ) {
    return "strong";
  }
  return "normal";
}

/** Pick the rep ID for a lead. Flat 3-way: strong → Leo, normal+overseas → Ethan,
 *  normal+domestic → Chenyu. The trailing `_unused` arg keeps signature compat
 *  with older call sites that passed `matchedDirections`. */
export function assignRep(
  config: AssignmentConfig,
  tier: "strong" | "normal",
  authorEmail?: string | null,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _unused?: unknown,
): number {
  if (tier === "strong") return config.assignment.strong.rep_id;
  return isOverseas(authorEmail)
    ? config.assignment.overseas.rep_id
    : config.assignment.domestic.rep_id;
}
