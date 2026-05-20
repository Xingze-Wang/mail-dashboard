// Paper-level appropriateness filter.
//
// Per 2026-05-19 meta-audit finding: the 3-model judge scored an
// offensive-security paper (BadStyle, backdoor on LLaMA/DeepSeek/GPT)
// 9.67/9.67 because the intro was FAITHFUL to it. Faithfulness ≠
// "we should be offering this author free GPUs". Reputational landmine.
//
// This filter runs on the PAPER (title+abstract), not the intro,
// BEFORE the faithfulness judge. A perfectly faithful intro to a paper
// we shouldn't solicit is still blocked here.
//
// Direct port of ~/Desktop/Email/email_qc_appropriateness.py with the
// same two-tier design:
//   1. Deterministic signal scan (free): offensive-security vocab.
//      High-precision phrases in title → HARD; abstract attack words
//      against named commercial models → HARD; weaker signals →
//      escalate to judge.
//   2. Optional LLM judge for ambiguous cases. Strict mode per user
//      call: dual_use_risky also blocks. Fail-closed on judge errors.
//
// Defensive-security / robustness / safety / alignment / detection
// papers are GOOD fits and must NOT be blocked — the defensive_framing
// heuristic downgrades attack-keyword hits when those terms dominate.

import type { QcIssue } from "@/lib/email-structural-qc";

// High-precision OFFENSIVE phrases. Presence (esp. in title) is a strong
// "this is attack tooling" signal. Tuned to avoid defensive papers:
// "defense against jailbreak", "robust to adversarial" must NOT trip.
const OFFENSIVE_STRONG = [
  "jailbreak", "jailbreaking", "prompt injection", "data poisoning",
  "backdoor attack", "model extraction attack", "model stealing",
  "adversarial attack on", "evade detection", "evasion attack",
  "bypass safety", "bypass alignment", "circumvent guardrail",
  "remove safety", "uncensor", "unalign", "poisoning attack",
  "membership inference attack", "extraction of training data",
  "exfiltrat", "weaponiz", "malware generation", "exploit generation",
  "attack against", "attacking large language models",
  "attack llm", "attack llms", "red-team attack", "offensive security",
];

// Named commercial / well-known models — being the TARGET of an attack
// paper is the specific landmine.
const NAMED_TARGETS = [
  "llama", "deepseek", "gpt-4", "gpt-3", "gpt4", "chatgpt", "claude",
  "gemini", "qwen", "mistral", "openai", "anthropic",
];

// Defensive-context vocabulary that DOWNGRADES a hit when nearby.
const DEFENSIVE_CONTEXT = [
  "defense", "defend", "defending", "robust", "robustness",
  "mitigat", "detect", "detection", "protect", "safeguard",
  "alignment", "safety", "harmless", "guardrail", "resilien",
  "countermeasure", "against jailbreak", "against attack",
  "against adversarial", "against poisoning", "against backdoor",
];

// Weaker single signals → escalate to judge / SOFT, not HARD.
const OFFENSIVE_WEAK = [
  "adversarial", "perturbation", "trojan", "stealth", "covert",
  "vulnerability", "exploit", "attack surface",
];

// 2026-05-20 audience filter: hard-block when the author's email is at a
// US / EU / SG governmental research institution — they have their own
// compute and aren't in our ICP. Chinese .gov.cn / 中科院 / 国内 national
// labs are KEPT (core target group). Match on email domain only —
// deterministic, zero cost.
//
// Logic: any `.gov` TLD that is NOT `.gov.cn` (which is a SLD form used
// only by China), plus a list of named non-Chinese government labs.
const NAMED_NON_CN_GOV_DOMAINS = [
  // US national labs (DOE / DOD / civilian)
  "ornl.gov", "lanl.gov", "lbl.gov", "anl.gov", "bnl.gov", "pnnl.gov",
  "sandia.gov", "llnl.gov", "fnal.gov", "slac.stanford.edu",  // SLAC is DOE-funded
  "nist.gov", "nasa.gov", "noaa.gov", "usgs.gov", "nih.gov",
  "nrl.navy.mil", "afrl.af.mil", "arl.army.mil",
  // EU
  "cern.ch", "esa.int", "eso.org", "embl.org", "embl.de", "embl-ebi.ac.uk",
  "max-planck.de",  // 'mpg.de' is in SCHOOL_DATA as "MPI" tier 1 — keep there, don't double-block
  // Singapore
  "a-star.edu.sg", "astar.edu.sg",
  // Japan
  "riken.jp", "aist.go.jp",
];

function isBlockedGovDomain(email: string): { blocked: boolean; reason?: string } {
  if (!email || !email.includes("@")) return { blocked: false };
  const domain = email.split("@").pop()!.toLowerCase();

  // Named non-CN government labs first (most specific)
  for (const d of NAMED_NON_CN_GOV_DOMAINS) {
    if (domain === d || domain.endsWith(`.${d}`)) {
      return { blocked: true, reason: `government research institution (${d}) — outside our ICP, has own compute` };
    }
  }
  // .gov TLD (US federal) — but NOT .gov.cn (Chinese .gov), which is a
  // SLD used only by China and is a target audience.
  if (domain.endsWith(".gov") && !domain.endsWith(".gov.cn")) {
    return { blocked: true, reason: `US government TLD (${domain}) — outside our ICP` };
  }
  // .mil — US military, also outside ICP
  if (domain.endsWith(".mil")) {
    return { blocked: true, reason: `US military domain (${domain}) — outside our ICP` };
  }
  return { blocked: false };
}

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_TIMEOUT_MS = 25_000;

function norm(s: string): string {
  return (s || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function sample(s: string, n = 70): string {
  s = (s || "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function countMatches(haystack: string, needles: string[]): number {
  let n = 0;
  for (const w of needles) {
    let i = 0;
    while ((i = haystack.indexOf(w, i)) !== -1) { n++; i += w.length; }
  }
  return n;
}

function defensiveFraming(text: string): boolean {
  // Heuristic: if strong defensive vocabulary dominates, attack keywords
  // are likely being discussed as the THREAT being defended against.
  return countMatches(text, DEFENSIVE_CONTEXT) >= 2;
}

const JUDGE_SYSTEM =
  "You are a strict screening filter for a program that offers FREE GPU compute to research authors. Output JSON only.";

function judgePrompt(title: string, abstract: string): string {
  return `A program offers free GPU compute to research authors.
We must NOT solicit papers whose primary contribution is OFFENSIVE:
attacking, jailbreaking, poisoning, backdooring, evading, extracting,
or otherwise compromising other AI systems or models — especially
named commercial models. DEFENSIVE work (robustness, safety, alignment,
defense against attacks, detection) is a GOOD fit and must be allowed.

Title: ${title}
Abstract: ${(abstract || "").slice(0, 1400)}

Classify the paper's PRIMARY contribution:
- "fine": legitimate research, including defensive security / robustness / safety / alignment.
- "offensive": primary contribution is an attack / jailbreak / poisoning / evasion / extraction technique, or tooling to compromise AI systems.
- "dual_use_risky": ambiguous; could be framed either way / clearly weaponizable as described.

Return JSON only:
{"category": "fine|offensive|dual_use_risky",
 "targets_named_model": true|false,
 "reason": "one sentence citing the abstract"}`;
}

interface ParsedJudge {
  category?: string;
  targets_named_model?: boolean;
  reason?: string;
}

function parseJudgeJson(raw: string): ParsedJudge | null {
  if (!raw) return null;
  let t = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first >= 0 && last > first) t = t.slice(first, last + 1);
  try { return JSON.parse(t) as ParsedJudge; } catch { return null; }
}

async function callJudgeGemini(prompt: string): Promise<string> {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error("GOOGLE_API_KEY not set");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { role: "system", parts: [{ text: JUDGE_SYSTEM }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 2500 },
        }),
        signal: controller.signal,
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`gemini ${res.status}: ${body.slice(0, 200)}`);
    }
    const j = await res.json();
    return j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  } finally {
    clearTimeout(timer);
  }
}

export interface AppropriatenessResult {
  ok: boolean;
  hard: QcIssue[];
  soft: QcIssue[];
  category?: "fine" | "offensive" | "dual_use_risky" | "blocked_audience" | "no_judge";
}

/**
 * Screen a paper for ethical appropriateness BEFORE drafting/sending.
 *
 * Returns `ok = false` if the paper should not be solicited. Two ways
 * a paper fails: (a) deterministic hit on offensive-strong vocab in
 * title, or in abstract WITH a named commercial model target (+ no
 * defensive framing); (b) LLM judge classifies as "offensive" OR
 * "dual_use_risky".
 *
 * `useJudge=false` runs the deterministic layer only — useful in
 * draft-queue where we already have an LLM bill from the 3-model
 * intro judge. Import-time should pass `useJudge=true` for full strict.
 */
export async function screenPaperAppropriateness(args: {
  title: string;
  abstract: string;
  authorEmail?: string;
  useJudge?: boolean;
}): Promise<AppropriatenessResult> {
  const hard: QcIssue[] = [];
  const soft: QcIssue[] = [];
  const title = args.title || "";
  const abstract = args.abstract || "";

  // (0) Audience filter — hard-block US/EU/SG/JP government labs by email
  // domain. Chinese .gov.cn / cas.cn / ict.ac.cn are NOT blocked
  // (core target audience). Zero LLM cost.
  if (args.authorEmail) {
    const govCheck = isBlockedGovDomain(args.authorEmail);
    if (govCheck.blocked) {
      hard.push({
        code: "BLOCKED_AUDIENCE",
        severity: "HARD",
        message: govCheck.reason || "audience outside ICP",
        sample: args.authorEmail,
      });
      return { ok: false, hard, soft, category: "blocked_audience" };
    }
  }

  const ttl = norm(title);
  const abs = norm(abstract);
  const blob = `${ttl} ||| ${abs}`;

  if (!ttl && !abs) {
    soft.push({
      code: "APPR_NO_TEXT",
      severity: "SOFT",
      message: "no title/abstract to screen for appropriateness",
    });
    return { ok: true, hard, soft, category: "no_judge" };
  }

  const isDefensive = defensiveFraming(blob);

  const titleHits = OFFENSIVE_STRONG.filter((p) => ttl.includes(p));
  const bodyHits = OFFENSIVE_STRONG.filter((p) => abs.includes(p));
  const targets = NAMED_TARGETS.filter((m) => blob.includes(m));

  // (1) Strong offensive phrase in TITLE = immediate hard block.
  if (titleHits.length > 0 && !isDefensive) {
    hard.push({
      code: "OFFENSIVE_TITLE",
      severity: "HARD",
      message: `title indicates offensive/attack work (${titleHits.slice(0, 3).join(", ")}) — do not solicit; reputational risk`,
      sample: sample(title),
    });
    return { ok: false, hard, soft, category: "offensive" };
  }

  // (2) Abstract attack vocab against a named commercial model = hard block.
  if (bodyHits.length > 0 && targets.length > 0 && !isDefensive) {
    hard.push({
      code: "OFFENSIVE_VS_NAMED_MODEL",
      severity: "HARD",
      message: `abstract describes attack work (${bodyHits.slice(0, 3).join(", ")}) against named model(s) (${targets.slice(0, 3).join(", ")}) — landmine`,
      sample: sample(abstract),
    });
    return { ok: false, hard, soft, category: "offensive" };
  }

  // (3) Weaker signals: escalate to judge if available, else SOFT.
  const weakHits = OFFENSIVE_WEAK.filter((w) => blob.includes(w));
  const suspicious = bodyHits.length > 0 || weakHits.length >= 2;

  if (!suspicious || isDefensive) {
    return { ok: true, hard, soft, category: "fine" };
  }

  // Suspicious + not obviously defensive — call the judge if asked.
  if (!args.useJudge) {
    soft.push({
      code: "OFFENSIVE_WEAK_SIGNAL",
      severity: "SOFT",
      message: `weak offensive signal(s) (${[...bodyHits, ...weakHits].slice(0, 4).join(", ")}); no judge run — review manually`,
      sample: sample(abstract),
    });
    return { ok: true, hard, soft, category: "no_judge" };
  }

  let parsed: ParsedJudge | null = null;
  try {
    const raw = await callJudgeGemini(judgePrompt(title, abstract));
    parsed = parseJudgeJson(raw);
  } catch {
    parsed = null;
  }

  if (!parsed) {
    // Fail-closed per 2026-05-19 user call: don't ship anything we
    // couldn't verify when offensive signals are already present.
    hard.push({
      code: "APPR_JUDGE_UNAVAILABLE",
      severity: "HARD",
      message: "appropriateness judge failed and offensive signals present — fail-closed",
      sample: sample(abstract),
    });
    return { ok: false, hard, soft, category: "dual_use_risky" };
  }

  const cat = (parsed.category || "").toLowerCase() as "fine" | "offensive" | "dual_use_risky" | string;
  const reason = String(parsed.reason || "").slice(0, 140);

  if (cat === "offensive") {
    hard.push({
      code: "JUDGE_OFFENSIVE",
      severity: "HARD",
      message: `appropriateness judge: offensive primary contribution — ${reason}`,
      sample: sample(abstract),
    });
    return { ok: false, hard, soft, category: "offensive" };
  }
  if (cat === "dual_use_risky") {
    // Strict mode per 2026-05-19: dual-use = block.
    hard.push({
      code: "JUDGE_DUAL_USE",
      severity: "HARD",
      message: `appropriateness judge: dual-use / weaponizable (strict mode = block) — ${reason}`,
      sample: sample(abstract),
    });
    return { ok: false, hard, soft, category: "dual_use_risky" };
  }

  soft.push({
    code: "APPR_JUDGE_CLEARED",
    severity: "SOFT",
    message: `weak offensive signals but judge cleared as fine — ${reason}`,
  });
  return { ok: true, hard, soft, category: "fine" };
}
