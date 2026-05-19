// Salvage preprocessor for leaky LLM outputs.
//
// Reasoning-tier models often emit scratchpad BEFORE the real one-sentence
// intro:
//   "好的，让我想想… Wait, is it one sentence? -> 最近在跟踪X方向…"
// The real intro is usually the LAST clean Chinese 四段论 sentence after
// all the leak text. Rather than always burning a Gemini regenerate call,
// try to recover that sentence. If salvage produces a plausible intro
// (looks like 四段论, no banned symbols), return it — structural QC runs
// again on the salvaged version, so safety is preserved either way.
//
// Direct port of ~/Desktop/Email/email_qc_harden.py:strip_cot_leak.

const LEAK_CUT_MARKERS = [
  "</think>", "<think>", "好的，", "好的。", "当然，", "以下是",
  "根据您的要求", "根据论文写", "个性化开头", "一句话）", "一句话)",
  "必须以句号", "不要中途", "中途截断", "思考：", "分析：", "草稿：",
  "重新写", "重写", "再写一遍", "正确例子", "错误例子", "示例：",
  "Option A", "Option B", "option a", "option b",
  "Here is", "Here's", "Sure,", "Certainly", "Okay,", "Let me",
  "Let's", "Wait,", "Hmm,", "Actually,", "I need to", "I should",
  "We need", "make sure", "Final answer", "final answer",
  "最终答案", "答案：", "Answer:", "Revised", "revised",
  "->", "→",
];

const GOOD_OPENER = "最近在";
const GOOD_PAPERREF = "读到";
const GOOD_FOURTH = ["如果能有更多算力", "如果有更多算力", "更多算力支持"];
const TERMINATORS = "。！？!?";
const BANNED_SYMBOLS = ['"', "“", "”", "*", "//", "%", "$", "`",
  "#", "@", "&", "=", "+", "\\", "<", ">", "|", "~"];

function looksChinese(s: string): boolean { return /[一-鿿]/.test(s); }

function isPlausibleIntro(s: string): boolean {
  if (!s || [...s].length < 20 || [...s].length > 220) return false;
  if (!looksChinese(s)) return false;
  for (const b of BANNED_SYMBOLS) if (s.includes(b)) return false;
  if (!s.includes(GOOD_OPENER) || !s.includes(GOOD_PAPERREF)) return false;
  if (!GOOD_FOURTH.some((g) => s.includes(g))) return false;
  const last = s.trimEnd().slice(-1);
  if (!TERMINATORS.includes(last)) return false;
  const interior = s.replace(/[。！？!?…]+$/, "").trimEnd();
  if (/[。！？!?]/.test(interior)) return false;  // must be ONE sentence
  return true;
}

/**
 * Best-effort recover the real 四段论 intro from a leaky generation.
 * Returns raw if salvage fails. Downstream QC always re-validates, so
 * salvage cannot weaken safety.
 */
export function stripCotLeak(raw: string): string {
  if (!raw) return raw;
  const text = raw.trim();

  // A — already clean
  if (isPlausibleIntro(text)) return text;

  // B — cut past the last leak marker
  let cutAt = -1;
  for (const mk of LEAK_CUT_MARKERS) {
    const idx = text.lastIndexOf(mk);
    if (idx !== -1) {
      const end = idx + mk.length;
      if (end > cutAt) cutAt = end;
    }
  }
  let textForC = text;
  if (cutAt !== -1) {
    const tail = text.slice(cutAt).trim().replace(/^["'“”]+|["'“”]+$/g, "").trim();
    if (isPlausibleIntro(tail)) return tail;
    if (tail) textForC = tail;
  }

  // C — last "最近在 … <terminator>" span anywhere in the text. Use
  // matchAll to find all opener positions, then scan forward to the next
  // terminator for each one. Prefer the latest match (post-CoT).
  const candidates: string[] = [];
  for (const m of textForC.matchAll(/最近在/g)) {
    const start = m.index ?? -1;
    if (start < 0) continue;
    const seg = textForC.slice(start);
    const term = seg.search(/[。！？!?]/);
    if (term !== -1) candidates.push(seg.slice(0, term + 1).trim());
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    if (isPlausibleIntro(candidates[i])) return candidates[i];
  }

  // D — unsalvageable
  return raw;
}
