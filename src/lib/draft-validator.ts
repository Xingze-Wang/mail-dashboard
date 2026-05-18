// Quality gate: validates a fully-rendered draft before it can flip to
// `ready` status. Called by the drainer and prod cron right before DB write.
//
// Two severity tiers:
//   - HARD: do NOT save to ready. Drainer retries the LLM call.
//   - SOFT: save to ready but include warnings in audit metadata.
//
// Shared between auditor + drainer + cron so all three use identical
// rules. Single source of truth.

const SENTENCE_END_RE = /[。．\.!！?？]["'』」）)]?\s*$/;

const LLM_META_PATTERNS: RegExp[] = [
  /Let's check/i,
  /Let's refine/i,
  /Let me/i,
  /Looking at/i,
  /Step \d+:/i,
  /\(\d+\s*chars?\)/i,
  /fourth part/i,
  /Three-part structure/i,
  /I must output/i,
  /raw text, no/i,
  /option\s+a:/i,
  /option\s+b:/i,
];

const PROMPT_LEAK_PATTERNS: RegExp[] = [
  /推断作者下一步/,
  /严禁[:：]/,
  /标题超.*改成/,
  /\[X方向\]|\[Y方法\]|\[Z问题\]|\[作者可能想做的事\]/,
  /注意[:：]\s*[1-9]\./,
  /逗号是标点符号/,
  /三段论/,
  /markdown\/引号/,
];

export interface ValidationIssue {
  key: string;
  severity: "HARD" | "SOFT";
  evidence?: string;
}

export interface ValidationResult {
  ok: boolean;
  hard: ValidationIssue[];
  soft: ValidationIssue[];
}

function extractIntro(html: string | null | undefined): string | null {
  if (!html) return null;
  const parts = html.split(/<br\s*\/?>\s*<br\s*\/?>/i);
  if (parts.length < 2) return null;
  return parts[1].replace(/<[^>]+>/g, "").replace(/&[a-z]+;/gi, " ").trim();
}

export function validateDraft(args: {
  subject: string | null | undefined;
  html: string | null | undefined;
  introOutput?: string | null;
}): ValidationResult {
  const html = args.html || "";
  const subject = args.subject || "";
  const intro = args.introOutput ?? extractIntro(html);
  const stripped = html.replace(/<[^>]+>/g, " ");
  const hard: ValidationIssue[] = [];
  const soft: ValidationIssue[] = [];

  if (intro && !SENTENCE_END_RE.test(intro.trim())) {
    hard.push({ key: "intro_truncated", severity: "HARD", evidence: intro.trim().slice(-60) });
  }
  if (/\\u[0-9a-f]{4}/.test(html)) {
    hard.push({ key: "json_unicode_leak", severity: "HARD" });
  }
  if (/\["[^"]+",\s*"[^"]+"\]/.test(stripped)) {
    hard.push({ key: "fragment_brackets", severity: "HARD" });
  }
  for (const re of LLM_META_PATTERNS) {
    if (re.test(stripped)) {
      const m = re.exec(stripped);
      hard.push({ key: "llm_meta_leak", severity: "HARD", evidence: m?.[0] });
      break;
    }
  }
  for (const re of PROMPT_LEAK_PATTERNS) {
    if (re.test(stripped)) {
      const m = re.exec(stripped);
      hard.push({ key: "prompt_instructions_leak", severity: "HARD", evidence: m?.[0] });
      break;
    }
  }
  if (!subject.trim()) hard.push({ key: "empty_subject", severity: "HARD" });
  if (!html.trim()) hard.push({ key: "empty_body", severity: "HARD" });
  if (html && !/[一-龥A-Za-z]{1,30}你好[，,]/.test(html.slice(0, 500))) {
    hard.push({ key: "greeting_missing", severity: "HARD" });
  }
  if (html && !/奇绩创坛/.test(html)) {
    hard.push({ key: "signature_missing", severity: "HARD" });
  }

  if (/\{\{REP_NAME\}\}|\{\{REP_WECHAT\}\}|\{\{CLOSING_NAME\}\}/.test(html)) {
    soft.push({ key: "placeholder_leak", severity: "SOFT" });
  }
  if (intro && intro.trim().length < 40) {
    soft.push({ key: "abnormally_short_intro", severity: "SOFT", evidence: `${intro.trim().length} chars` });
  }
  if (intro && intro.trim().length > 300) {
    soft.push({ key: "abnormally_long_intro", severity: "SOFT", evidence: `${intro.trim().length} chars` });
  }

  return { ok: hard.length === 0, hard, soft };
}
