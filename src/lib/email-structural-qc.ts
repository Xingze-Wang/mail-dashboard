// Structural quality lock for outreach emails.
//
// This file is one of two mirrors of the lock — the other is the Python
// `email_qc.py` in the sibling scanner repo. scripts/lint-qc-constants-sync.mjs
// fails CI if their constants diverge. If you edit BLOCK3_FIXED, school
// thresholds, COT_LEAK_MARKERS, INTRO_* limits, or BANNED_INTRO_SYMBOLS here,
// edit the Python mirror in lockstep.
//
// Philosophy: the email is ~95% fixed text. Only blocks 1 (greeting),
// 2 (personalized intro), and 4 (school paragraph variant) vary. So instead
// of pattern-hunting for known-bad outputs, we ALLOW only well-formed inputs
// and reject anything that can't reproduce the template envelope.
//
// Two severity tiers — see HARD_CODES below:
//   HARD = email cannot ship; caller must rewrite or quarantine.
//   SOFT = annotate + warn; not blocking. Includes "missing 4th 算力 clause"
//          and intro-length issues per 2026-05-19 product call.

export type Severity = "HARD" | "SOFT";

export interface QcIssue {
  code: string;
  severity: Severity;
  message: string;
  sample?: string;
}

export interface QcResult {
  ok: boolean;             // no HARD issues
  hard: QcIssue[];
  soft: QcIssue[];
  blocks: string[];        // the parsed visible paragraphs (empty if BLOCK_COUNT failed)
}

// ─── Codes that block send. Anything not in this set is SOFT. ───
const HARD_CODES = new Set([
  "BLOCK_COUNT",
  "BLOCK3_ALTERED",
  "BLOCK6_ALTERED",
  "GREETING_SHAPE",
  "INTRO_MISSING",
  "INTRO_TOO_SHORT",
  "INTRO_TOO_LONG",
  "INTRO_NOT_CHINESE",
  "INTRO_BANNED_SYMBOL",
  "INTRO_COT_LEAK",
  "INTRO_EN_QUESTION",
  "INTRO_ARROW_MAPPING",
  "INTRO_QUOTED_LEAK",
  "INTRO_PROMPT_ECHO",
  "INTRO_TRUNCATED",
  "INTRO_MULTI_SENTENCE",
  "SERVER_PLACEHOLDER_UNFILLED",
  "FSTRING_LEAK",
  "SUBJECT_FSTRING_LEAK",
  "SUBJECT_TOO_SHORT",
  "SUBJECT_PREFIX",
]);

// ─── Mirrored constants (keep in sync with email_qc.py) ───
const SUBJECT_PREFIX = "Invitation to Apply - ";
const SUBJECT_SUFFIX = "的潜在算力支持机会";

const FALLBACK_INTRO =
  "最近在跟踪 AI 算力相关的研究方向时，读到了您团队的工作，其中的方法很有启发。";

// CoT / refusal / prompt-echo markers. If any appears in the intro, hard-block.
const COT_LEAK_MARKERS = [
  "<think>", "</think>", "好的，", "好的。", "当然，", "以下是",
  "首先，我", "让我", "我将", "我会为", "思考：", "分析：", "草稿：",
  "Option A", "Option B", "Here is", "Here's", "Sure,", "Certainly", "Okay,",
  "I cannot", "I can't", "I'm unable", "As an AI",
  "Wait,", "Hmm,", "Actually,", "Let's", "let me",
  "one sentence", "I need to", "I should", "make sure",
  "根据论文写", "写一句", "个性化开头", "必须以句号", "中途截断",
  "重新写", "重写", "Rewrite", "Revised", "Final answer", "最终答案",
  "正确例子", "错误例子", "->", "→ \"",
];

const BANNED_INTRO_SYMBOLS = [
  '"', "“", "”", "*", "//", "%", "$", "`",
  "#", "@", "&", "=", "+", "\\", "<", ">", "|", "~",
];

// Calibrated for what the pipeline actually emits (per the 2026-05-19 audit).
// Spec called for 28 but real intros include long English paper titles
// ("Towards Generalized Image Manipulation Localization paper" = 56 chars).
const MAX_LATIN_RUN = 80;
const LATIN_RUN_RE = new RegExp(`[A-Za-z][A-Za-z ,'\\-]{${MAX_LATIN_RUN - 1},}`);

const INTRO_MIN_CHARS = 24;
const INTRO_MAX_CHARS = 220;
const INTRO_MIN_SEGMENTS = 3;
const INTRO_MAX_SEGMENTS = 6;
const INTRO_MAX_SEGMENT_CHARS = 55;
const INTRO_QZHONG_CLAUSE_MAX = 45;

// ─── Helpers ───
function decode(t: string): string {
  return t
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function splitBlocks(html: string): string[] {
  if (!html) return [];
  let t = html.replace(/<br\s*\/?>/gi, "<br>");
  t = t.replace(/<\/?(?:html|head|body|meta)[^>]*>/gi, "");
  const parts = t.split(/(?:<br>\s*){2,}/);
  const out: string[] = [];
  for (const p of parts) {
    const txt = decode(p.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (txt) out.push(txt);
  }
  return out;
}

function looksChinese(s: string): boolean { return /[一-鿿]/.test(s); }

function sample(s: string, n = 80): string {
  s = (s || "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function push(issues: QcIssue[], code: string, message: string, smpl?: string): void {
  issues.push({
    code,
    severity: HARD_CODES.has(code) ? "HARD" : "SOFT",
    message,
    sample: smpl,
  });
}

// ─── Per-block checks ───
function checkSubject(s: string, issues: QcIssue[]): void {
  s = (s || "").trim();
  if (s.length < 10) push(issues, "SUBJECT_TOO_SHORT", `${s.length} chars`, s.slice(0, 40));
  if (!s.startsWith(SUBJECT_PREFIX)) push(issues, "SUBJECT_PREFIX", "missing prefix", s.slice(0, 50));
  if (!s.endsWith(SUBJECT_SUFFIX)) push(issues, "SUBJECT_SUFFIX", "missing suffix", s.slice(-40));
  const probe = s.replaceAll("{{", "").replaceAll("}}", "");
  const m = probe.match(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/);
  if (m) push(issues, "SUBJECT_FSTRING_LEAK", `unrendered ${m[0]}`, m[0]);
}

function checkGreeting(b: string, issues: QcIssue[]): void {
  if (!/^.{0,40}你好，$/.test(b)) push(issues, "GREETING_SHAPE", "not '<name>你好，'", sample(b));
}

function checkIntro(intro: string, issues: QcIssue[]): void {
  intro = intro.trim();
  if (!intro) { push(issues, "INTRO_MISSING", "empty"); return; }
  if (intro === FALLBACK_INTRO) {
    push(issues, "INTRO_IS_FALLBACK", "fallback (no personalization)");
    return;  // fallback is structurally legal — skip further checks
  }

  const L = [...intro].length;
  if (L < INTRO_MIN_CHARS) push(issues, "INTRO_TOO_SHORT", `${L} chars`, sample(intro));
  if (L > INTRO_MAX_CHARS) push(issues, "INTRO_TOO_LONG", `${L} chars`, sample(intro));
  if (!looksChinese(intro)) push(issues, "INTRO_NOT_CHINESE", "no Chinese", sample(intro));

  for (const sym of BANNED_INTRO_SYMBOLS) {
    if (intro.includes(sym)) { push(issues, "INTRO_BANNED_SYMBOL", `contains ${JSON.stringify(sym)}`, sample(intro)); break; }
  }
  const low = intro.toLowerCase();
  for (const m of COT_LEAK_MARKERS) {
    if (low.includes(m.toLowerCase())) { push(issues, "INTRO_COT_LEAK", `marker ${JSON.stringify(m)}`, sample(intro)); break; }
  }
  if (/[A-Za-z][A-Za-z ,']{2,}\?/.test(intro))
    push(issues, "INTRO_EN_QUESTION", "English question (CoT leak)", sample(intro));
  if (intro.includes("->") || intro.includes("→"))
    push(issues, "INTRO_ARROW_MAPPING", "arrow operator", sample(intro));

  if (!intro.includes("最近在")) push(issues, "INTRO_NO_OPENER", "missing 最近在", sample(intro));
  if (!intro.includes("读到")) push(issues, "INTRO_NO_PAPER_REF", "missing 读到", sample(intro));
  if (!(intro.includes("如果能有更多算力") || intro.includes("如果有更多算力") || intro.includes("更多算力支持"))) {
    push(issues, "INTRO_NO_FOURTH_CLAUSE", "missing 4th 算力 clause", sample(intro));
  }

  // Accept BOTH CN 。， and EN ., — real drafts use English punctuation
  const commaN = (intro.match(/[，,]/g) || []).length;
  if (commaN < 2) push(issues, "INTRO_NOT_FOUR_SEGMENT", `${commaN} commas`, sample(intro));

  const trimmed = intro.replace(/[。！？!?.]+$/, "");
  const segments = trimmed.split(/[，,]/).map((s) => s.trim()).filter(Boolean);
  if (segments.length < INTRO_MIN_SEGMENTS) push(issues, "INTRO_TOO_FEW_SEGMENTS", `${segments.length} seg`, sample(intro));
  if (segments.length > INTRO_MAX_SEGMENTS) push(issues, "INTRO_TOO_MANY_SEGMENTS", `${segments.length} seg`, sample(intro));
  for (let i = 0; i < segments.length; i++) {
    const segLen = [...segments[i]].length;
    if (segLen > INTRO_MAX_SEGMENT_CHARS) { push(issues, "INTRO_SEGMENT_TOO_LONG", `clause ${i + 1}: ${segLen}c`, sample(segments[i])); break; }
  }
  for (const seg of segments) {
    if (seg.includes("其中")) {
      const segLen = [...seg].length;
      if (segLen > INTRO_QZHONG_CLAUSE_MAX) push(issues, "INTRO_METHOD_CLAUSE_TOO_LONG", `${segLen}c`, sample(seg));
      break;
    }
  }

  const last = intro.trimEnd().slice(-1);
  if (!"。！？!?.".includes(last))
    push(issues, "INTRO_TRUNCATED", `ends on ${JSON.stringify(last)}`, sample(intro.slice(-40)));

  const m = intro.match(LATIN_RUN_RE);
  if (m) push(issues, "INTRO_EN_PROSE", `${m[0].length}-char EN run`, sample(m[0]));
}

function checkFixedBlocks(blocks: string[], queueMode: boolean, issues: QcIssue[]): void {
  const [, , b3, b4, , b6] = blocks;
  // Block 3 sales paragraph — verify by required substrings (more robust than byte-exact)
  if (!b3.includes("奇绩创坛的") || !b3.includes("奇绩算力计划")) push(issues, "BLOCK3_ALTERED", "sales paragraph altered", sample(b3));
  if (!b6.includes("奇绩创坛")) push(issues, "BLOCK6_ALTERED", "missing 奇绩创坛", sample(b6));

  const joined = blocks.join(" ");
  for (const ph of ["{{REP_NAME}}", "{{REP_WECHAT}}"]) {
    if (joined.includes(ph)) {
      // In queue mode (status != ready), unfilled placeholders are expected — soft.
      // At send time (queueMode=false), they're catastrophic — hard.
      if (queueMode) push(issues, "SERVER_PLACEHOLDER_PRESENT", `${ph} present (queue ok)`);
      else push(issues, "SERVER_PLACEHOLDER_UNFILLED", `${ph} reached send unfilled`);
    }
  }
  const probe = joined.replaceAll("{{", "").replaceAll("}}", "");
  const m = probe.match(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/);
  if (m) push(issues, "FSTRING_LEAK", `unrendered ${m[0]}`);

  // Block 4 — soft keyword check (the byte-exact reconstruction in the spec
  // had too much drift against live SCHOOL_DATA variants to be safe).
  if (!(b4.includes("奇绩算力") || b4.includes("1.5%") || b4.includes("100万"))) {
    push(issues, "BLOCK4_OFF_TEMPLATE", "block 4 lacks expected keywords", sample(b4));
  }
}

export interface ValidateArgs {
  subject: string | null | undefined;
  html: string | null | undefined;
  /** false when called from send-path; true (default) when called from
   *  draft-queue (where unfilled {{REP_*}} placeholders are expected). */
  queueMode?: boolean;
}

export function validateEmailStructure(args: ValidateArgs): QcResult {
  const issues: QcIssue[] = [];
  const queueMode = args.queueMode !== false;

  checkSubject(args.subject || "", issues);
  const blocks = splitBlocks(args.html || "");
  if (blocks.length !== 6) {
    push(issues, "BLOCK_COUNT", `got ${blocks.length} blocks (expected 6)`);
    return {
      ok: false,
      hard: issues.filter((i) => i.severity === "HARD"),
      soft: issues.filter((i) => i.severity === "SOFT"),
      blocks,
    };
  }
  checkGreeting(blocks[0], issues);
  checkIntro(blocks[1], issues);
  checkFixedBlocks(blocks, queueMode, issues);

  const hard = issues.filter((i) => i.severity === "HARD");
  const soft = issues.filter((i) => i.severity === "SOFT");
  return { ok: hard.length === 0, hard, soft, blocks };
}

// Re-export the HARD code set so the rewrite module can know which failures
// it should attempt to fix vs. which it must escalate (e.g. SUBJECT_PREFIX
// is HARD but rewriting the intro won't fix it).
export const REWRITABLE_HARD_CODES = new Set([
  "INTRO_MISSING",
  "INTRO_TOO_SHORT",
  "INTRO_TOO_LONG",
  "INTRO_NOT_CHINESE",
  "INTRO_BANNED_SYMBOL",
  "INTRO_COT_LEAK",
  "INTRO_EN_QUESTION",
  "INTRO_ARROW_MAPPING",
  "INTRO_QUOTED_LEAK",
  "INTRO_PROMPT_ECHO",
  "INTRO_TRUNCATED",
  "INTRO_MULTI_SENTENCE",
]);
