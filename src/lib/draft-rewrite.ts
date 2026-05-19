// LLM-driven rewrite for drafts that hard-fail structural QC.
//
// Per 2026-05-19 design: when validateEmailStructure() returns hard issues
// and they are in REWRITABLE_HARD_CODES, we re-run the intro generation
// with the previous failed output + the specific failure reasons appended
// to the prompt. Only the intro (block 2) is regenerated — everything else
// in the email is fixed text or template-rendered and stays as-is.
//
// Per the same conversation: email-gen LLM calls go DIRECT to Gemini
// (generativelanguage.googleapis.com) using GOOGLE_API_KEY, not through
// the MiraclePlus llmChat proxy. See memory feedback_no_direct_gemini
// (updated 2026-05-19).

import type { QcIssue } from "@/lib/email-structural-qc";
import { REWRITABLE_HARD_CODES, validateEmailStructure } from "@/lib/email-structural-qc";
import { stripCotLeak } from "@/lib/intro-salvage";

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_TIMEOUT_MS = 25_000;
const MAX_ATTEMPTS = 2;

export interface RewriteAttempt {
  attempt: number;
  newIntro: string;
  resolvedPrompt: string;
  qcCodesAfter: string[];
  ok: boolean;
  errorMessage?: string;
}

export interface RewriteResult {
  ok: boolean;
  finalHtml: string;
  finalIntro: string;
  attempts: RewriteAttempt[];
  reason?: string;
}

/**
 * Substitute a new intro into the given HTML. The HTML is the 6-block
 * email; block 2 is the intro (between the first two <br><br> separators).
 * We do a structural swap rather than a regex on the intro text — that
 * way callers don't need to know the exact previous intro string.
 */
function replaceIntroBlock(html: string, newIntro: string): string {
  const sep = /(<br\s*\/?>\s*){2,}/gi;
  const matches = [...html.matchAll(sep)];
  if (matches.length < 2) {
    // Can't find the two boundaries that bracket block 2 — likely
    // BLOCK_COUNT failure. Caller should route to full regenerate.
    return html;
  }
  const blockStart = matches[0].index! + matches[0][0].length;
  const blockEnd = matches[1].index!;
  return html.slice(0, blockStart) + newIntro + html.slice(blockEnd);
}

function buildRewritePrompt(args: {
  title: string;
  abstract: string;
  previousIntro: string;
  failures: QcIssue[];
}): string {
  const failureLines = args.failures
    .filter((f) => REWRITABLE_HARD_CODES.has(f.code))
    .map((f) => `  - ${f.code}: ${f.message}${f.sample ? ` (sample: ${f.sample.slice(0, 80)})` : ""}`)
    .join("\n");

  return `根据论文写一句个性化开头（1句话），用四段论结构：
1) 最近在跟踪[X方向]的研究时
2) 读到你的[paper名]
3) 其中[Y方法]解决[Z问题]的方案很有启发
4) 如果能有更多算力支持，相信可以在[扩展方向]验证[泛化能力/普适性/...]

约束：
- 必须是 1 句中文，以 句号 / . 结尾
- 不要使用引号、星号、反斜杠、URL、Markdown 标记
- 不要泄露任何推理过程、Wait/Let's/Rewrite 等元话语
- 总长度 24-220 字
- 第 3 段方法子句不超过 45 字

标题: ${args.title}
摘要: ${args.abstract.slice(0, 1000)}

【你上次的输出失败了，原因：
${failureLines}

你上次的失败输出：
${args.previousIntro}
】

请只输出符合约束的那一句话，不要任何前缀、后缀、解释。`;
}

async function callGeminiDirect(prompt: string): Promise<string> {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error("GOOGLE_API_KEY not set");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 800,
          topP: 0.95,
        },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`gemini ${res.status}: ${body.slice(0, 200)}`);
    }
    const j = await res.json();
    const text = j?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== "string" || !text.trim()) {
      throw new Error("gemini empty response");
    }
    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}

function isRewritable(hard: QcIssue[]): boolean {
  if (hard.some((h) => h.code === "BLOCK_COUNT")) return false;
  if (hard.some((h) => ["SUBJECT_PREFIX", "SUBJECT_TOO_SHORT", "BLOCK3_ALTERED", "BLOCK6_ALTERED", "GREETING_SHAPE"].includes(h.code))) return false;
  return hard.some((h) => REWRITABLE_HARD_CODES.has(h.code));
}

export async function rewriteDraftIntro(args: {
  html: string;
  subject: string;
  title: string;
  abstract: string;
  previousIntro: string;
  hard: QcIssue[];
}): Promise<RewriteResult> {
  if (!isRewritable(args.hard)) {
    return {
      ok: false,
      finalHtml: args.html,
      finalIntro: args.previousIntro,
      attempts: [],
      reason: "non_rewritable",
    };
  }

  // ── FREE SALVAGE PRE-PASS (port of email_qc_harden.strip_cot_leak) ──
  // If the failing intro is just a leaky generation with the real 四段论
  // sentence buried inside it, try to recover the clean sentence with
  // pure string surgery — no LLM call. Re-validate; if QC passes, we
  // skip the regenerate entirely.
  const salvaged = stripCotLeak(args.previousIntro);
  if (salvaged && salvaged !== args.previousIntro) {
    const salvagedHtml = replaceIntroBlock(args.html, salvaged);
    const salvageQc = validateEmailStructure({
      subject: args.subject,
      html: salvagedHtml,
      queueMode: true,
    });
    if (salvageQc.ok) {
      return {
        ok: true,
        finalHtml: salvagedHtml,
        finalIntro: salvaged,
        attempts: [
          {
            attempt: 0,
            newIntro: salvaged,
            resolvedPrompt: "(salvage: stripCotLeak, no LLM call)",
            qcCodesAfter: [],
            ok: true,
          },
        ],
        reason: "salvaged",
      };
    }
  }

  const attempts: RewriteAttempt[] = [];
  let currentHtml = args.html;
  let currentIntro = args.previousIntro;
  let currentFailures = args.hard;

  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    const prompt = buildRewritePrompt({
      title: args.title,
      abstract: args.abstract,
      previousIntro: currentIntro,
      failures: currentFailures,
    });

    let newIntro: string;
    try {
      newIntro = await callGeminiDirect(prompt);
    } catch (err) {
      attempts.push({
        attempt: i,
        newIntro: "",
        resolvedPrompt: prompt,
        qcCodesAfter: [],
        ok: false,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    newIntro = newIntro.replace(/^["'`]|["'`]$/g, "").trim();

    const newHtml = replaceIntroBlock(currentHtml, newIntro);
    const qc = validateEmailStructure({ subject: args.subject, html: newHtml, queueMode: true });
    attempts.push({
      attempt: i,
      newIntro,
      resolvedPrompt: prompt,
      qcCodesAfter: qc.hard.map((h) => h.code),
      ok: qc.ok,
    });
    currentHtml = newHtml;
    currentIntro = newIntro;
    currentFailures = qc.hard;
    if (qc.ok) {
      return { ok: true, finalHtml: newHtml, finalIntro: newIntro, attempts, reason: "success" };
    }
  }

  return {
    ok: false,
    finalHtml: currentHtml,
    finalIntro: currentIntro,
    attempts,
    reason: "exhausted",
  };
}
