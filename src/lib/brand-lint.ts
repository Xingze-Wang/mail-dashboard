/**
 * Brand-term lint. Catches misspellings of protected terms in draft
 * edits so sales doesn't send "奇迹创坛" / "奇绩创谭" out the door.
 *
 * Kept as a pure module so:
 *   - Unit-testable without DOM.
 *   - The helper robot's "alert" mood can fire off this signal without
 *     the UI layer knowing what the rule set is.
 *   - If the rule list grows, it's one place.
 *
 * Rules are hand-written — this is not a general spellchecker. The
 * value of a tight, low-false-positive list is high; a noisy one
 * would train reps to ignore the alert.
 */

export interface BrandLintHit {
  /** The incorrect phrase as it appears in the text. */
  found: string;
  /** The correct replacement. */
  expected: string;
  /** Character offset in the input. */
  index: number;
  /** Optional human explanation; surfaced in the toast. */
  note?: string;
}

interface Rule {
  bad: RegExp;
  expected: string;
  note?: string;
}

/**
 * The rules. Each `bad` regex MUST be specific enough that false
 * positives are ~0 — the UI fires a proactive robot-wave on match,
 * and a nagging assistant is worse than silence.
 *
 * Anchored without \b because Chinese text has no word boundaries
 * that JS regex understands — specificity comes from matching the
 * full phrase, not a single character.
 */
const RULES: Rule[] = [
  // Core brand: must be 奇绩 (not 奇迹 / 奇蹟)
  { bad: /奇迹创坛/g,  expected: "奇绩创坛", note: "品牌名是「奇绩」(同「成绩」), 不是「奇迹」" },
  { bad: /奇蹟创坛/g,  expected: "奇绩创坛", note: "品牌名是「奇绩」, 不是繁体「奇蹟」" },
  { bad: /奇绩创谭/g,  expected: "奇绩创坛", note: "是「创坛」(论坛的坛), 不是「创谭」" },
  { bad: /奇迹算力/g,  expected: "奇绩算力", note: "「奇绩算力」, 不是「奇迹算力」" },
  { bad: /奇蹟算力/g,  expected: "奇绩算力", note: "「奇绩算力」, 不是繁体「奇蹟」" },

  // Bare "奇迹" on its own is too generic to flag globally (it's a real
  // Chinese word). But if it's adjacent to the program brand markers,
  // it's almost certainly a typo.
  { bad: /(?<!\w)奇迹(?=计划|程序|项目)/g, expected: "奇绩", note: "program 名字是「奇绩」" },
];

export function lintBrand(text: string): BrandLintHit[] {
  if (!text) return [];
  const hits: BrandLintHit[] = [];
  for (const r of RULES) {
    for (const m of text.matchAll(r.bad)) {
      if (typeof m.index !== "number") continue;
      hits.push({
        found: m[0],
        expected: r.expected,
        index: m.index,
        note: r.note,
      });
    }
  }
  return hits;
}

/**
 * True if any hit was added since the last known set — used by the
 * UI's debounce loop to decide whether to fire the robot-wave event.
 * Compares by `found + index` so re-typing the same mistake doesn't
 * spam the user on every keystroke.
 */
export function findsNewHits(prev: BrandLintHit[], next: BrandLintHit[]): BrandLintHit[] {
  if (next.length === 0) return [];
  const seen = new Set(prev.map((h) => `${h.found}@${h.index}`));
  return next.filter((h) => !seen.has(`${h.found}@${h.index}`));
}
