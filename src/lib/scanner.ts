// arxiv paper scanner — TypeScript port of resend0331.py
// Designed for Vercel serverless: no heavy Node-only deps.

import { supabase } from "@/lib/db";
import {
  CHINESE_SURNAMES,
  SCHOOL_DATA,
  ALL_DIRECTIONS,
  CATEGORIES,
  type SchoolInfo,
} from "@/lib/scanner-config";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ScannedLead {
  arxivId: string;
  title: string;
  abstract: string;
  authors: string;
  pdfUrl: string;
  publishedAt: string | null;
  authorName: string;
  authorEmail: string;
  firstName: string | null;
  schoolName: string | null;
  schoolTier: number | null;
  computeLevel: string;
  computeConfidence: number;
  computeReason: string;
  matchedDirections: string[];
}

interface ArxivPaper {
  title: string;
  abstract: string;
  authors: string[];
  pdfUrl: string;
  arxivId: string;
  published: string | null;
}

interface EmailMatch {
  email: string;
  author: string | null;
  is_chinese: boolean;
  first_name: string | null;
}

interface GeminiAnalysis {
  email_matches: EmailMatch[];
  needs_compute: boolean;
  compute_confidence: number;
  compute_level: string;
  compute_reason: string;
  matched_directions: string[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const ARXIV_BATCH_SIZE = 100;
const ARXIV_DELAY_MS = 250;
const GEMINI_DELAY_MS = 200;
const DEFAULT_TIME_BUDGET_MS = 45_000;
const DEFAULT_MAX_PAPERS = 2000;

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// ─── LaTeX cleaning (ported from Python) ─────────────────────────────────────

const SUPERSCRIPT_MAP: Record<string, string> = {
  "0": "\u2070", "1": "\u00B9", "2": "\u00B2", "3": "\u00B3", "4": "\u2074",
  "5": "\u2075", "6": "\u2076", "7": "\u2077", "8": "\u2078", "9": "\u2079",
  "+": "\u207A", "-": "\u207B", "=": "\u207C", "(": "\u207D", ")": "\u207E",
  n: "\u207F", i: "\u2071", x: "\u02E3", y: "\u02B8",
};

const SUBSCRIPT_MAP: Record<string, string> = {
  "0": "\u2080", "1": "\u2081", "2": "\u2082", "3": "\u2083", "4": "\u2084",
  "5": "\u2085", "6": "\u2086", "7": "\u2087", "8": "\u2088", "9": "\u2089",
  "+": "\u208A", "-": "\u208B", "=": "\u208C", "(": "\u208D", ")": "\u208E",
  a: "\u2090", e: "\u2091", i: "\u1D62", o: "\u2092", u: "\u1D64",
  r: "\u1D63", k: "\u2096", v: "\u1D65", x: "\u2093", n: "\u2099",
};

const LATEX_REPLACEMENTS: Record<string, string> = {
  "\\log": "log", "\\exp": "exp", "\\max": "max", "\\min": "min",
  "\\sum": "\u03A3", "\\prod": "\u03A0", "\\infty": "\u221E",
  "\\alpha": "\u03B1", "\\beta": "\u03B2", "\\gamma": "\u03B3",
  "\\delta": "\u03B4", "\\epsilon": "\u03B5", "\\lambda": "\u03BB",
  "\\theta": "\u03B8", "\\pi": "\u03C0", "\\sigma": "\u03C3",
  "\\mu": "\u03BC", "\\omega": "\u03C9", "\\phi": "\u03C6",
  "\\psi": "\u03C8", "\\tau": "\u03C4", "\\rho": "\u03C1",
  "\\eta": "\u03B7", "\\nu": "\u03BD", "\\times": "\u00D7",
  "\\cdot": "\u00B7", "\\leq": "\u2264", "\\geq": "\u2265",
  "\\neq": "\u2260", "\\approx": "\u2248", "\\rightarrow": "\u2192",
  "\\leftarrow": "\u2190", "\\sim": "~", "\\propto": "\u221D",
  "\\in": "\u2208", "\\subset": "\u2282",
};

function translateChars(s: string, map: Record<string, string>): string {
  return Array.from(s)
    .map((c) => map[c] ?? c)
    .join("");
}

function cleanMathInTitle(title: string): string {
  // Strip inline math delimiters
  title = title.replace(/\$([^$]+)\$/g, "$1");
  // \text{...}, \mathrm{...}, etc.
  title = title.replace(
    /\\(?:text|mathrm|mathit|textit|textbf)\{([^}]+)\}/g,
    "$1",
  );
  title = title.replace(
    /\\(?:mathcal|mathbb|boldsymbol|bm)\{([^}]+)\}/g,
    "$1",
  );

  // Superscripts
  title = title.replace(/\^{([^}]+)}|\^(\w)/g, (_m, g1, g2) => {
    const c = g1 ?? g2;
    if (c.length <= 4) return translateChars(c, SUPERSCRIPT_MAP);
    return `^${c}`;
  });

  // Subscripts
  title = title.replace(/_{([^}]+)}|_(\w)/g, (_m, g1, g2) => {
    const c = g1 ?? g2;
    const t = translateChars(c, SUBSCRIPT_MAP);
    return t !== c ? t : `_${c}`;
  });

  // Named LaTeX commands
  for (const [latex, uni] of Object.entries(LATEX_REPLACEMENTS)) {
    // Use split/join for literal replacement (no regex escaping needed)
    title = title.split(latex).join(uni);
  }

  // Remaining \command → command
  title = title.replace(/\\(\w+)/g, "$1");
  // Remove braces
  title = title.replace(/\{([^}]*)\}/g, "$1");

  return title.trim();
}

function cleanTitle(title: string): string {
  title = cleanMathInTitle(title);
  return title.replace(/\?/g, "").trim();
}

const INVALID_CHARS = [
  "%", "*", "#", "@", "&", "=", "+", "/", "\\", '"', "'", "<", ">", "|", "~",
  "`",
];

function hasInvalidCharacters(title: string): boolean {
  return INVALID_CHARS.some((c) => title.includes(c));
}

// ─── Chinese surname detection ───────────────────────────────────────────────

function likelyHasChineseAuthor(authors: string[]): boolean {
  for (const name of authors) {
    const parts = name.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const last = parts[parts.length - 1].toLowerCase();
    if (CHINESE_SURNAMES.has(last)) return true;
    const first = parts[0].toLowerCase();
    if (CHINESE_SURNAMES.has(first)) return true;
  }
  return false;
}

// ─── School lookup ───────────────────────────────────────────────────────────

function getSchoolInfo(email: string): SchoolInfo | null {
  const domain = email.split("@").pop()?.toLowerCase() ?? "";
  if (SCHOOL_DATA[domain]) return SCHOOL_DATA[domain];
  const parts = domain.split(".");
  for (let i = 1; i < parts.length; i++) {
    const partial = parts.slice(i).join(".");
    if (SCHOOL_DATA[partial]) return SCHOOL_DATA[partial];
  }
  return null;
}

// ─── Atom XML parsing ────────────────────────────────────────────────────────

function parseAtomFeed(xml: string): ArxivPaper[] {
  const papers: ArxivPaper[] = [];

  // Split on <entry> tags
  const entries = xml.split("<entry>");
  // First chunk is the <feed> header, skip it
  for (let i = 1; i < entries.length; i++) {
    const entry = entries[i];

    const titleMatch = entry.match(/<title[^>]*>([\s\S]*?)<\/title>/);
    const summaryMatch = entry.match(/<summary[^>]*>([\s\S]*?)<\/summary>/);
    const publishedMatch = entry.match(
      /<published[^>]*>([\s\S]*?)<\/published>/,
    );
    const idMatch = entry.match(/<id[^>]*>([\s\S]*?)<\/id>/);

    // Extract authors
    const authorMatches = [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)];
    const authors = authorMatches.map((m) => m[1].trim());

    // Extract pdf link
    const pdfMatch = entry.match(
      /<link[^>]*title="pdf"[^>]*href="([^"]+)"/,
    );

    if (!titleMatch || !summaryMatch || !idMatch) continue;

    const rawTitle = titleMatch[1].replace(/\s+/g, " ").trim();
    const abstract = summaryMatch[1].replace(/\s+/g, " ").trim();
    const published = publishedMatch ? publishedMatch[1].trim() : null;
    const fullId = idMatch[1].trim();
    // e.g. http://arxiv.org/abs/2501.00001v1 → 2501.00001v1 → 2501.00001
    const arxivId = fullId.split("/").pop()?.replace(/v\d+$/, "") ?? fullId;
    const pdfUrl =
      pdfMatch?.[1] ?? `https://arxiv.org/pdf/${arxivId}`;

    papers.push({
      title: rawTitle,
      abstract,
      authors,
      pdfUrl,
      arxivId,
      published,
    });
  }

  return papers;
}

// ─── Fetch papers from arxiv Atom API ────────────────────────────────────────

async function fetchArxivBatch(
  offset: number,
  batchSize: number,
): Promise<ArxivPaper[]> {
  const catQuery = CATEGORIES.map((c) => `cat:${c}`).join("+OR+");
  const url =
    `http://export.arxiv.org/api/query?search_query=${catQuery}&sortBy=submittedDate&start=${offset}&max_results=${batchSize}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; MiraclePlusScanner/1.0; mailto:leo@compute.miracleplus.com)",
    },
  });

  if (!res.ok) {
    throw new Error(`arxiv API returned ${res.status}: ${res.statusText}`);
  }

  const xml = await res.text();
  return parseAtomFeed(xml);
}

// ─── PDF email extraction (raw bytes regex) ──────────────────────────────────

async function extractEmailsFromPdf(pdfUrl: string): Promise<string[]> {
  try {
    const res = await fetch(pdfUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) return [];

    // Read as ArrayBuffer then decode as latin1 to get raw bytes as string
    const buf = await res.arrayBuffer();
    const raw = new TextDecoder("latin1").decode(buf);

    // Only look at roughly the first 20% of the PDF (first page area)
    const slice = raw.slice(0, Math.min(raw.length, Math.floor(raw.length * 0.2)));

    const matches = slice.match(EMAIL_PATTERN) ?? [];
    const unique = [...new Set(matches)];

    // Validate emails strictly
    return unique.filter((e) => {
      const [local, domain] = e.split("@");
      if (!local || !domain) return false;

      const domainParts = domain.split(".");
      // Must have at least 2 domain parts
      if (domainParts.length < 2) return false;

      // TLD must be at least 2 chars and only letters
      const tld = domainParts[domainParts.length - 1];
      if (tld.length < 2 || !/^[a-zA-Z]+$/.test(tld)) return false;

      // Domain parts must be reasonable length
      if (domainParts.some((p) => p.length < 1 || p.length > 63)) return false;

      // Local part must be reasonable (not just 1 char)
      if (local.length < 2) return false;

      // Reject obviously garbage domains
      if (domain.length < 5) return false;

      // Reject numeric-only domains
      if (/^\d+\.\d+$/.test(domain)) return false;

      return true;
    });
  } catch {
    return [];
  }
}

// ─── Gemini analysis ─────────────────────────────────────────────────────────

function parseLlmJson<T>(text: string, fallback: T): T {
  // Strip markdown code fences
  text = text
    .trim()
    .replace(/^```\w*\n?/g, "")
    .replace(/```$/g, "")
    .trim();

  try {
    return JSON.parse(text) as T;
  } catch {
    // Try to extract JSON object/array
    const match = text.match(/[\[{][\s\S]*[\]}]/);
    if (match) {
      try {
        return JSON.parse(match[0]) as T;
      } catch {
        // fall through
      }
    }
    return fallback;
  }
}

async function analyzeWithGemini(
  paper: ArxivPaper,
  emails: string[],
): Promise<GeminiAnalysis | null> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return null;

  const directionsStr = ALL_DIRECTIONS.join(", ");

  const prompt = `分析这篇论文，返回一个JSON对象。

标题: ${paper.title}
摘要: ${paper.abstract.slice(0, 800)}
作者: ${paper.authors.join(", ")}
邮箱: ${emails.join(", ")}

请完成以下三个任务：

---

## 任务一：邮箱-作者匹配
根据邮箱前缀匹配作者（wzhang→Wei Zhang, zhangwei→Zhang Wei等）。
判断是否中国人：纯拼音名=中国人（Xinhao Wang），混合名=非中国人（David Chen）。
first_name是中文名的拼音（如Xinhao），用于邮件称呼。

---

## 任务二：算力需求判断
从以下六个维度综合分析，判断作者是否需要非平凡的算力支持（即普通笔记本无法完成）。

**方法论信号（强信号）**
- 训练/微调深度学习模型（training、fine-tuning、pre-training）
- 强化学习（RL、RLHF、PPO等）
- 神经架构搜索、超参数大规模搜索
- 蒙特卡洛/分子动力学/有限元/CFD等数值模拟

**模型规模信号（强信号）**
- 提及参数量级（billions、millions of parameters）
- LLM、foundation model、large-scale model
- 多模态、多任务联合训练
- scaling law、scaling up

**数据规模信号（中信号）**
- large-scale dataset、web-scale、internet-scale
- 大量图像/视频/基因组数据处理

**基础设施信号（强信号）**
- GPU、TPU、A100、H100、distributed training、HPC

**实验规模信号（中信号）**
- 大量ablation study、多数据集全面评估

**领域信号（弱信号）**
- 气候/天体模拟、蛋白质折叠、药物发现、自动驾驶感知

**负向信号（降低判断）**
- "training-free"、"without training"、"lightweight"、"efficient"（指资源高效）
- 纯理论推导、综述论文、无实验的框架提案
- 仅"使用"现有模型做推理，不涉及训练
- 小规模定性研究、数学证明类工作
- 体育预测、简单分类任务、小数据集实验

**判断原则：**
1. 关注动词：train/fine-tune/simulate/optimize=强信号；analyze/survey/propose（无实验）=弱信号
2. 区分"提出"和"使用"：仅调用GPT-4 API做实验 ≠ 需要算力
3. compute_level含义：
   - heavy：多卡GPU/HPC集群（大模型预训练、大规模仿真）→ confidence 0.85-1.0
   - moderate：单卡或少量GPU（中等模型微调、中规模实验）→ confidence 0.65-0.85
   - light：普通服务器可满足（小模型训练、小规模模拟）→ confidence 0.5-0.65
   - none：理论/综述/纯数学/小规模定性研究 → needs_compute=false, confidence 0.0-0.4

---

## 任务三：研究方向匹配
从列表中找出最相关的2-3个方向（必须完全匹配列表名称，无匹配则返回空列表）。
方向列表：${directionsStr}

---

只返回JSON，不要其他文字：
{
  "email_matches": [
    {"email": "xx@xx.edu", "author": "全名或null", "is_chinese": true/false, "first_name": "名或null"}
  ],
  "needs_compute": true/false,
  "compute_confidence": 0.0-1.0,
  "compute_level": "heavy/moderate/light/none",
  "compute_reason": "一句话原因，需引用摘要中的具体证据",
  "matched_directions": ["方向1", "方向2"]
}`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
        }),
        signal: AbortSignal.timeout(20_000),
      },
    );

    if (!res.ok) {
      console.error(`Gemini API error: ${res.status}`);
      return null;
    }

    const data = await res.json();
    const text: string | undefined =
      data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;

    const result = parseLlmJson<GeminiAnalysis | null>(text, null);
    if (!result) return null;

    // Validate matched_directions against known list
    result.matched_directions = (result.matched_directions ?? [])
      .filter((d: string) => ALL_DIRECTIONS.includes(d))
      .slice(0, 3);

    return result;
  } catch (err) {
    console.error("Gemini analysis error:", err);
    return null;
  }
}

// ─── Dedup helpers ───────────────────────────────────────────────────────────

async function getExistingArxivIds(
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();

  // Check both pipeline_leads AND processed_papers tables
  const [{ data: leadRows }, { data: processedRows }] = await Promise.all([
    supabase.from("pipeline_leads").select("arxiv_id").in("arxiv_id", ids),
    supabase.from("processed_papers").select("arxiv_id").in("arxiv_id", ids),
  ]);

  const result = new Set<string>();
  for (const r of leadRows ?? []) result.add((r as { arxiv_id: string }).arxiv_id);
  for (const r of processedRows ?? []) result.add((r as { arxiv_id: string }).arxiv_id);
  return result;
}

async function getContactedEmails(
  emails: string[],
): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const lower = emails.map((e) => e.toLowerCase());

  // Check email_contact_history for contacts within the last 365 days
  const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();

  const [{ data: historyRows }, { data: sentRows }] = await Promise.all([
    supabase
      .from("email_contact_history")
      .select("email")
      .in("email", lower)
      .gte("contacted_at", oneYearAgo),
    supabase
      .from("emails")
      .select("to")
      .in("to", lower)
      .gte("created_at", oneYearAgo),
  ]);

  const result = new Set<string>();
  for (const r of historyRows ?? []) result.add((r as { email: string }).email.toLowerCase());
  for (const r of sentRows ?? []) result.add((r as { to: string }).to.toLowerCase());
  return result;
}

/** Record a processed paper so we don't re-analyze it */
async function markPaperProcessed(arxivId: string): Promise<void> {
  await supabase.from("processed_papers").upsert({ arxiv_id: arxivId });
}

/** Record that we contacted this email */
export async function recordContact(email: string, paperTitle: string, subject: string): Promise<void> {
  await supabase.from("email_contact_history").upsert({
    email: email.toLowerCase(),
    paper_title: paperTitle,
    subject,
    contacted_at: new Date().toISOString(),
    source: "pipeline",
  });
}

// ─── Sleep helper ────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Main scanner ────────────────────────────────────────────────────────────

export async function scanArxiv(options?: {
  maxPapers?: number;
  timeBudgetMs?: number;
}): Promise<{
  leads: ScannedLead[];
  stats: { checked: number; filtered: number; leads: number; errors: string[] };
}> {
  const maxPapers = options?.maxPapers ?? DEFAULT_MAX_PAPERS;
  const timeBudget = options?.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const deadline = Date.now() + timeBudget;

  const leads: ScannedLead[] = [];
  const errors: string[] = [];
  let checked = 0;
  let filtered = 0;
  let offset = 0;

  while (offset < maxPapers && Date.now() < deadline) {
    // ── Fetch a batch of papers from arxiv ──
    let batch: ArxivPaper[];
    try {
      batch = await fetchArxivBatch(offset, ARXIV_BATCH_SIZE);
    } catch (err) {
      errors.push(`arxiv fetch error at offset ${offset}: ${err}`);
      break;
    }

    if (batch.length === 0) break;
    offset += batch.length;

    // ── Dedup: skip papers already in pipeline_leads ──
    const batchIds = batch.map((p) => p.arxivId);
    let existingIds: Set<string>;
    try {
      existingIds = await getExistingArxivIds(batchIds);
    } catch {
      existingIds = new Set();
    }

    for (const paper of batch) {
      if (Date.now() >= deadline) break;
      checked++;

      // Skip already-imported papers
      if (existingIds.has(paper.arxivId)) {
        filtered++;
        continue;
      }

      // Chinese author filter
      if (!likelyHasChineseAuthor(paper.authors)) {
        filtered++;
        continue;
      }

      // Clean and validate title
      const cleaned = cleanTitle(paper.title);
      if (hasInvalidCharacters(cleaned)) {
        filtered++;
        continue;
      }

      // ── Extract emails from PDF ──
      const emails = await extractEmailsFromPdf(paper.pdfUrl);
      if (emails.length === 0) {
        filtered++;
        continue;
      }

      // Check if all emails were already contacted
      let contactedEmails: Set<string>;
      try {
        contactedEmails = await getContactedEmails(emails);
      } catch {
        contactedEmails = new Set();
      }
      const freshEmails = emails.filter(
        (e) => !contactedEmails.has(e.toLowerCase()),
      );
      if (freshEmails.length === 0) {
        filtered++;
        continue;
      }

      // ── Gemini analysis ──
      await sleep(GEMINI_DELAY_MS);
      let analysis: GeminiAnalysis | null;
      try {
        analysis = await analyzeWithGemini(paper, freshEmails);
      } catch (err) {
        errors.push(`Gemini error for ${paper.arxivId}: ${err}`);
        continue;
      }

      if (!analysis) {
        errors.push(`No analysis for ${paper.arxivId}`);
        continue;
      }

      // Skip if no compute need
      if (
        !analysis.needs_compute ||
        analysis.compute_confidence < 0.6 ||
        analysis.compute_level === "none"
      ) {
        filtered++;
        continue;
      }

      // ── Pick the first author (一作) with a Chinese name and fresh email ──
      // Walk the author list in order — first author is most important
      const chineseMatches = (analysis.email_matches ?? []).filter(
        (m) =>
          m.is_chinese &&
          m.author &&
          freshEmails.includes(m.email),
      );

      if (chineseMatches.length > 0) {
        // Sort by author position in the original paper author list (一作 first)
        const authorOrder = paper.authors.map((a) => a.toLowerCase());
        chineseMatches.sort((a, b) => {
          const posA = authorOrder.findIndex((name) =>
            name.includes((a.author ?? "").toLowerCase()) ||
            (a.author ?? "").toLowerCase().includes(name)
          );
          const posB = authorOrder.findIndex((name) =>
            name.includes((b.author ?? "").toLowerCase()) ||
            (b.author ?? "").toLowerCase().includes(name)
          );
          // -1 means not found — push to end
          return (posA === -1 ? 999 : posA) - (posB === -1 ? 999 : posB);
        });

        const best = { match: chineseMatches[0], school: getSchoolInfo(chineseMatches[0].email) };

        leads.push({
          arxivId: paper.arxivId,
          title: cleaned,
          abstract: paper.abstract,
          authors: paper.authors.join(", "),
          pdfUrl: paper.pdfUrl,
          publishedAt: paper.published,
          authorName: best.match.author ?? "",
          authorEmail: best.match.email,
          firstName: best.match.first_name ?? null,
          schoolName: best.school?.name ?? null,
          schoolTier: best.school?.tier ?? null,
          computeLevel: analysis.compute_level,
          computeConfidence: analysis.compute_confidence,
          computeReason: analysis.compute_reason ?? "",
          matchedDirections: analysis.matched_directions,
        });
      }

      // Mark paper as processed so we don't re-analyze it
      await markPaperProcessed(paper.arxivId);
    }

    // Rate limit between arxiv batches
    if (Date.now() < deadline) {
      await sleep(ARXIV_DELAY_MS);
    }
  }

  return {
    leads,
    stats: {
      checked,
      filtered,
      leads: leads.length,
      errors,
    },
  };
}
