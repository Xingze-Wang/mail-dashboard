/**
 * Shared rep color palette.
 * Used across SalesTab (rep cards), ChannelsTab (per-channel allocation legend),
 * Settings, and the lead-row rep dropdown — so a single rep is visually
 * identifiable everywhere in the app.
 *
 * Light theme only. ZERO gray (the unassigned slate is intentional, not gray).
 */

export interface RepPalette {
  /** Card / pill background gradient (light tint) */
  bg: string;
  /** Foreground/text color on the light background */
  color: string;
  /** Solid swatch color — for legend dots, bar segments, dropdown badges */
  solid: string;
  /** Progress-bar style gradient (deeper accent) */
  bar: string;
}

const REP_PALETTES: RepPalette[] = [
  // 0 — blue
  {
    bg: "linear-gradient(135deg, #DBEAFE, #BFDBFE)",
    color: "#1D4ED8",
    solid: "#2563EB",
    bar: "linear-gradient(90deg, #2563EB, #60A5FA)",
  },
  // 1 — pink/rose
  {
    bg: "linear-gradient(135deg, #FCE7F3, #FBCFE8)",
    color: "#BE185D",
    solid: "#BE185D",
    bar: "linear-gradient(90deg, #BE185D, #EC4899)",
  },
  // 2 — amber
  {
    bg: "linear-gradient(135deg, #FEF3C7, #FDE68A)",
    color: "#92400E",
    solid: "#B45309",
    bar: "linear-gradient(90deg, #B45309, #F59E0B)",
  },
  // 3 — emerald
  {
    bg: "linear-gradient(135deg, #D1FAE5, #A7F3D0)",
    color: "#047857",
    solid: "#16A34A",
    bar: "linear-gradient(90deg, #16A34A, #22C55E)",
  },
  // 4 — indigo
  {
    bg: "linear-gradient(135deg, #E0E7FF, #C7D2FE)",
    color: "#4338CA",
    solid: "#4338CA",
    bar: "linear-gradient(90deg, #4338CA, #818CF8)",
  },
  // 5 — cyan
  {
    bg: "linear-gradient(135deg, #CFFAFE, #A5F3FC)",
    color: "#0E7490",
    solid: "#0891B2",
    bar: "linear-gradient(90deg, #0891B2, #22D3EE)",
  },
];

/** Sentinel palette for unassigned/unknown reps (slate, not gray-on-gray). */
const UNASSIGNED_PALETTE: RepPalette = {
  bg: "linear-gradient(135deg, #E2E8F0, #CBD5E1)",
  color: "#475569",
  solid: "#64748B",
  bar: "linear-gradient(90deg, #475569, #94A3B8)",
};

/** Stable hash → palette index. Same name always picks the same palette. */
function hashIndex(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % REP_PALETTES.length;
}

/** Pick a deterministic palette for a rep name. */
export function paletteFor(repName: string | null | undefined): RepPalette {
  if (!repName) return UNASSIGNED_PALETTE;
  return REP_PALETTES[hashIndex(repName)];
}

/** Solid color shortcut — drop-in replacement for the old `colorForRep()`. */
export function colorForRep(repName: string | null | undefined): string {
  return paletteFor(repName).solid;
}

/** Initials helper, shared so avatars look the same everywhere. */
export function initialsFor(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}
