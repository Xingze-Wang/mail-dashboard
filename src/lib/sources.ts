/**
 * Canonical source identifiers and their display labels.
 *
 * Internal codes (`hf` / `ph` / `github` / `arxiv`) are what the Python
 * scrapers and `pipeline_leads.source` / `discovery_leads.source` store.
 * Display labels are what the UI renders.
 *
 * Single source of truth — both /api/discovery and /api/pipeline/analytics
 * import from here so the channel taxonomy never drifts.
 */

export type SourceCode = "hf" | "ph" | "github" | "arxiv";

export const SOURCE_LABELS: Record<SourceCode, string> = {
  hf: "Hugging Face",
  ph: "Product Hunt",
  github: "GitHub",
  arxiv: "arXiv",
};

/** Channels surfaced in the analytics breakdown, even when count is 0. */
export const KNOWN_CHANNELS: ReadonlyArray<string> = [
  SOURCE_LABELS.arxiv,
  SOURCE_LABELS.github,
  SOURCE_LABELS.hf,
  SOURCE_LABELS.ph,
];

/** Sources that flow through `discovery_leads` (everything except arXiv). */
export const DISCOVERY_SOURCES: ReadonlyArray<SourceCode> = ["hf", "ph", "github"];

/**
 * Normalize a raw `source` value (from either pipeline_leads or
 * discovery_leads) into its display label. Unknown / null inputs default
 * to "arXiv" — legacy `pipeline_leads` rows pre-dating the source column
 * came from arXiv.
 */
export function normalizeSourceLabel(raw: string | null | undefined): string {
  if (!raw) return SOURCE_LABELS.arxiv;
  const s = raw.trim().toLowerCase();
  if (s === "arxiv") return SOURCE_LABELS.arxiv;
  if (s === "github" || s === "gh") return SOURCE_LABELS.github;
  if (s === "huggingface" || s === "hugging_face" || s === "hf") return SOURCE_LABELS.hf;
  if (s === "producthunt" || s === "product_hunt" || s === "ph") return SOURCE_LABELS.ph;
  return raw;
}

/**
 * Map a display label back to the canonical short code used in the
 * discovery_leads table (or null if unknown / arXiv which has no
 * discovery row).
 */
export function labelToDiscoverySource(label: string): SourceCode | null {
  if (label === SOURCE_LABELS.hf) return "hf";
  if (label === SOURCE_LABELS.ph) return "ph";
  if (label === SOURCE_LABELS.github) return "github";
  return null;
}
