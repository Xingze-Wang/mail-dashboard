// Free deterministic grounding check for the intro sentence.
//
// Verifies that technical terms the LLM put in the intro are actually
// traceable to the paper's title + abstract. Catches "fluent but
// hallucinated" failures BEFORE we burn a Sonnet/GLM/Gemini judge call.
// Direct port of ~/Desktop/Email/email_qc_content.py:_check_grounding.
//
// Failure types it catches that the structural lock can't:
//   - 《quoted title》 that doesn't match the real title (wrong paper)
//   - "XXX paper" handle where XXX isn't a token of the real title
//   - Latin technical terms (CamelCase / acronym / hyphen-compound) that
//     don't appear anywhere in title or abstract
//
// >= 2 ungrounded terms → HARD; exactly 1 → SOFT (could be paraphrase).

import type { QcIssue } from "./email-structural-qc";

const MIN_TERM_LEN = 4;
const GROUNDING_HARD_THRESHOLD = 2;

const ABBREV: Record<string, string> = {
  rl: "reinforcement learning",
  llm: "large language model",
  llms: "large language models",
  vlm: "vision language model",
  vla: "vision language action",
  rlhf: "reinforcement learning from human feedback",
  rag: "retrieval augmented generation",
  moe: "mixture of experts",
  sft: "supervised fine-tuning",
  dpo: "direct preference optimization",
  ppo: "proximal policy optimization",
  cot: "chain of thought",
  ssm: "state space model",
  gnn: "graph neural network",
  nerf: "neural radiance field",
  ood: "out of distribution",
  ssl: "self supervised",
  ner: "named entity recognition",
};

const TERM_RE = /\b([A-Z][a-zA-Z]+[A-Z][a-zA-Z]*|[A-Z]{2,}(?:-[A-Z0-9]+)*|[a-zA-Z]+(?:-[a-zA-Z]+)+)\b/g;
const QUOTED_TITLE_RE = /《([^》]{2,200})》/g;
const PAPER_HANDLE_RE = /([A-Za-z][A-Za-z0-9\-]{2,})\s*paper/g;
const PARAPHRASE_RE = /关于.{2,40}的论文/;

function norm(s: string): string {
  return (s || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function sample(s: string, n = 60): string {
  s = (s || "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function grounded(term: string, sourceNorm: string): boolean {
  const t = term.trim().toLowerCase();
  if (t.length < MIN_TERM_LEN) return true;
  if (sourceNorm.includes(t)) return true;
  const exp = ABBREV[t];
  if (exp && sourceNorm.includes(exp)) return true;
  if (t.includes("-")) {
    if (sourceNorm.replace(/-/g, "").includes(t.replace(/-/g, ""))) return true;
    if (sourceNorm.includes(t.replace(/-/g, " "))) return true;
  }
  const spaced = term.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  if (spaced !== t && sourceNorm.includes(spaced)) return true;
  return false;
}

export interface GroundingResult {
  ungrounded_terms: string[];
  issues: QcIssue[];
}

export function checkIntroGrounding(args: {
  intro: string;
  title: string;
  abstract: string;
}): GroundingResult {
  const issues: QcIssue[] = [];
  const src = norm(args.title) + " ||| " + norm(args.abstract);

  // 1. Quoted 《》 title vs real title — wrong-paper catcher.
  for (const m of args.intro.matchAll(QUOTED_TITLE_RE)) {
    const qt = m[1];
    const qtn = norm(qt);
    const tn = norm(args.title);
    if (!tn.includes(qtn) && !qtn.includes(tn)) {
      issues.push({
        code: "QUOTED_TITLE_MISMATCH",
        severity: "HARD",
        message: "intro quotes 《…》 that does not match the real paper title — wrong paper / hallucinated title",
        sample: sample(qt),
      });
    }
  }

  // 2. "XXX paper" handle vs real title — wrong-paper catcher.
  if (!PARAPHRASE_RE.test(args.intro)) {
    for (const m of args.intro.matchAll(PAPER_HANDLE_RE)) {
      const handle = m[1];
      const h = handle.toLowerCase();
      if (h.length < 3) continue;
      const tn = norm(args.title);
      if (!tn.includes(h) && !tn.replace(/-/g, "").includes(h.replace(/-/g, ""))) {
        issues.push({
          code: "PAPER_HANDLE_MISMATCH",
          severity: "HARD",
          message: `intro calls it '${handle} paper' but '${handle}' is not in the real title — likely wrong paper`,
          sample: sample(handle),
        });
      }
    }
  }

  // 3. Technical-term grounding — hallucination catcher.
  // Strip quoted titles first (they may legitimately contain novel coinages).
  const introWoQuoted = args.intro.replace(QUOTED_TITLE_RE, " ");
  const seen = new Set<string>();
  const ungrounded: string[] = [];
  for (const m of introWoQuoted.matchAll(TERM_RE)) {
    const term = m[1];
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!grounded(term, src)) ungrounded.push(term);
  }

  if (ungrounded.length >= GROUNDING_HARD_THRESHOLD) {
    issues.push({
      code: "UNGROUNDED_TERMS",
      severity: "HARD",
      message: `${ungrounded.length} technical term(s) not in paper title/abstract: ${ungrounded.slice(0, 6).join(", ")}`,
      sample: sample(args.intro),
    });
  } else if (ungrounded.length === 1) {
    issues.push({
      code: "UNGROUNDED_TERM",
      severity: "SOFT",
      message: `term ${JSON.stringify(ungrounded[0])} not found in title/abstract — verify`,
      sample: sample(args.intro),
    });
  }

  return { ungrounded_terms: ungrounded, issues };
}
