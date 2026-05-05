// Congress bench: run multiple named congress configurations against the same
// evidence pack and compare their recommendations.
//
// A "congress configuration" is a named combination of:
//   - model (which LLM powers all personas)
//   - persona emphasis (how aggressive each role is)
//   - deliberation style (Conservative / Expansionist / Empiricist)
//
// The interesting output isn't format compliance — it's recommendation
// divergence. When three configs all recommend the same change, it's an
// obvious decision. When they split, the evidence is genuinely ambiguous
// and a human needs to adjudicate.

import { llmChat } from "@/lib/llm-proxy";
import { supabase } from "@/lib/db";

// ── Evidence packs ────────────────────────────────────────────────────────────
// Realistic congress inputs. Each pack is a question the council must answer.

export const CONGRESS_SAMPLES = [
  {
    id: "ev_001",
    title: "Subject line A/B: question vs. statement",
    evidence: `
Evidence pack:
- Sent 240 emails in the last 14 days: 120 with question subject lines ("Are you scaling your training cluster?"), 120 with statement subjects ("We support large-scale GPU clusters for ML research").
- Open rate: question 34.2% vs. statement 28.7% (+5.5pp).
- Reply rate: question 4.2% vs. statement 5.1% (+0.9pp for statement).
- Click rate: question 2.1% vs. statement 1.8%.
- Recipients: cs.LG, cs.AI, cs.CV; 68% Chinese institutions; Tier 1 and Tier 2 split 40/60.
- Current global template uses statement-style subjects.
- Baseline open rate: 30.1% (90d rolling). Significance threshold: 80 sends per arm (already met).
`.trim(),
  },
  {
    id: "ev_002",
    title: "Routing tweak: deprioritize Tier 3 leads for Leo",
    evidence: `
Evidence pack:
- Leo has 87 Tier 3 leads assigned in the last 30 days; wechat conversion rate: 0.8%.
- Leo has 34 Tier 1 leads assigned; wechat conversion rate: 8.2%.
- Team average Tier 3 wechat rate: 1.4%.
- Leo's total wechat conversions this month: 12 (4 from Tier 3, 8 from Tier 1/2).
- Proposed change: cap Leo's Tier 3 assignments at 20% of his weekly batch; redirect excess to Ethan.
- Ethan's Tier 3 wechat rate: 2.1%. Ethan is at 90% capacity (28/31 assigned leads responded to).
- Chenyu has headroom: 18/30 assigned leads responded to. Tier 3 rate unknown (only 6 assigned).
`.trim(),
  },
  {
    id: "ev_003",
    title: "Template expansion: add a second email for non-responders at 10 days",
    evidence: `
Evidence pack:
- 62% of all sent leads receive no follow-up if they don't respond within 7 days.
- Of leads who eventually converted via WeChat: 34% responded to the first email, 41% responded to a follow-up within 14 days, 25% were initiated by the rep on WeChat directly.
- Proposed: auto-send a shorter follow-up email at day 10 if no reply and no WeChat contact.
- Concern: 3 reps have sent informal follow-ups manually; anecdotally "about half feel annoying."
- Current average lead age at WeChat conversion: 8.4 days. No A/B data on follow-up emails.
- Compliance note: no opt-out mechanism exists in the current template system.
`.trim(),
  },
];

// ── Congress configurations ───────────────────────────────────────────────────
// Each config = a named deliberation style. Same evidence, different lens.
// The persona prompts encode the bias of that "advisory firm."

export interface CongressConfig {
  id: string;
  name: string;
  tagline: string;
  color: string; // for UI differentiation
  model: string;
  personaOverrides: Partial<Record<string, { system?: string; question?: string }>>;
  synthesizer_instruction: string;
}

const BASE_PERSONAS = {
  data_analyst: {
    system: "你是 Qiji 算力 program 的 data analyst. 简洁, 用数字, 不下判断, 只报告.",
    question: "What's the single most actionable metric movement in the evidence? Call out sample size, confidence level, and whether the signal is reliable enough to act on.",
  },
  copywriter: {
    system: "你是销售邮件文案. 关心邮件 prose, subject line, 模板的具体措辞.",
    question: "Given the evidence, what's one prose-level change worth testing? Be specific — exact subject line or exact phrase swap.",
  },
  academic_proxy: {
    system: "你代表收件人 — 一位中国 AI researcher. 你不是 sales, 你是 reader.",
    question: "From the recipient's POV, what's the most off-putting or compelling thing about this proposed change?",
  },
  sales_director: {
    system: "你是 sales director — 关心 rep 的 workflow + 时间 + 信心.",
    question: "What are the operational consequences for the reps if this change is approved? Who benefits, who bears the cost?",
  },
  psychologist: {
    system: "你是 psychologist. 你看 emotional/cognitive state — 收件人和 rep 两侧.",
    question: "What emotional response does this change create — in the recipient who receives it, and in the rep who has to execute it?",
  },
  adversary: {
    system: "你的工作是 attack 任何提议的改动. 假设其他 panelist 都太乐观.",
    question: "Read what others said. Pick the strongest implicit proposal and attack it — what's the most likely reason it FAILS?",
  },
};

export const CONGRESS_CONFIGS: CongressConfig[] = [
  {
    id: "conservative",
    name: "Conservative",
    tagline: "High burden of proof. Defaults to defer.",
    color: "zinc",
    model: "gemini-2.5-flash",
    personaOverrides: {
      data_analyst: {
        question: "Is the sample size sufficient for a causal claim? What's the confidence interval? State explicitly whether this evidence meets the 80-send threshold and whether it's statistically significant.",
      },
      adversary: {
        system: "你的工作是 attack 任何提议的改动. 你极度悲观. 你只需要找到一个真实的失败模式.",
        question: "What is the single most likely failure mode of this proposal? Give a concrete scenario where approving this causes net harm. Don't hedge.",
      },
    },
    synthesizer_instruction: `You are a cautious synthesizer. Default to 'defer' unless the evidence clearly supports action.
The bar for 'approve': sample ≥80 per arm, signal consistent across rep/tier, no adversary critique lands.
Produce JSON: { "title":"one-line summary", "recommendation":"approve"|"reject"|"defer", "confidence":0.0-1.0,
"change":{"kind":"subject_line_test"|"template_phrase_swap"|"routing_tweak"|"copy_edit"|"scope_expansion", "details":"exact change in plain language"},
"rationale":"2 sentences — why this recommendation", "key_dissent":"what the adversary said that almost changed your mind" }
JSON only.`,
  },
  {
    id: "expansionist",
    name: "Expansionist",
    tagline: "Looks for scope and category growth opportunities.",
    color: "emerald",
    model: "claude-sonnet-4-6",
    personaOverrides: {
      sales_director: {
        question: "Beyond the immediate proposal, what adjacent opportunity does this evidence reveal? Is there a larger scope change (new rep assignment rule, new target segment, new follow-up cadence) that would capture more upside?",
      },
      academic_proxy: {
        question: "From the researcher's perspective, what kind of outreach would actually feel welcome and relevant? What would make you respond vs. ignore?",
      },
    },
    synthesizer_instruction: `You are an expansionist synthesizer. Look for the largest defensible scope of change the evidence can support.
If a small change is proposed, consider whether a larger structural change would capture more upside.
Produce JSON: { "title":"one-line summary", "recommendation":"approve"|"reject"|"defer", "confidence":0.0-1.0,
"change":{"kind":"subject_line_test"|"template_phrase_swap"|"routing_tweak"|"copy_edit"|"scope_expansion", "details":"exact change in plain language"},
"rationale":"2 sentences — why this recommendation", "scope_note":"if you recommend a broader change than proposed, explain why" }
JSON only.`,
  },
  {
    id: "empiricist",
    name: "Empiricist",
    tagline: "Evidence-gated. No data, no recommendation.",
    color: "blue",
    model: "gpt-5-mini",
    personaOverrides: {
      data_analyst: {
        system: "你是 data analyst. 你有否决权. 如果数据不足, 你可以阻止整个讨论.",
        question: "State: (1) sample size per arm, (2) whether it meets threshold, (3) p-value or confidence interval if computable, (4) confounders that aren't controlled for. If sample < 80 or evidence is anecdotal, say 'INSUFFICIENT — defer until data accumulates.' This is a veto.",
      },
      adversary: {
        question: "Identify the confounders. What else changed in the same period that could explain this result? What experiment would you need to run to be confident?",
      },
    },
    synthesizer_instruction: `You are an evidence-gated synthesizer. If the data_analyst says 'INSUFFICIENT', your recommendation MUST be 'defer'.
Produce JSON: { "title":"one-line summary", "recommendation":"approve"|"reject"|"defer", "confidence":0.0-1.0,
"change":{"kind":"subject_line_test"|"template_phrase_swap"|"routing_tweak"|"copy_edit"|"scope_expansion", "details":"exact change in plain language"},
"rationale":"2 sentences — why this recommendation", "data_verdict":"restate the data_analyst's verdict on evidence quality" }
JSON only.`,
  },
];

// ── Per-persona runner ────────────────────────────────────────────────────────

async function runPersona(
  key: string,
  base: { system: string; question: string },
  override: { system?: string; question?: string } | undefined,
  evidencePack: string,
  runningContext: string,
  configName: string,
  model: string,
): Promise<string> {
  const system = override?.system ?? base.system;
  const question = override?.question ?? base.question;
  const displayName = key.replace("_", " ");

  const userPrompt = `## ${configName} congress — your role: ${displayName}
${question}

## Evidence pack
${evidencePack}
${runningContext ? `\n## What the panel has said so far\n${runningContext}` : ""}

200 words max. Cite specifics from the evidence. Don't repeat what others said — push back, refine, or add what's missing.`;

  try {
    const r = await llmChat({
      model,
      system,
      user: userPrompt,
      temperature: 0.5,
      max_tokens: 600,
      timeoutMs: 60_000,
    });
    return r.text?.trim() ?? "(empty)";
  } catch (err) {
    return `(errored: ${String(err).slice(0, 80)})`;
  }
}

// ── Main runner ───────────────────────────────────────────────────────────────

export interface CongressRunResult {
  configId: string;
  configName: string;
  sampleId: string;
  sampleTitle: string;
  model: string;
  personas: Record<string, string>;
  recommendation: "approve" | "reject" | "defer" | null;
  confidence: number | null;
  change: { kind: string; details: string } | null;
  rationale: string | null;
  extraFields: Record<string, string>;
  latency_s: number;
  tokens_out: number | null;
  error: string | null;
}

export async function runCongressConfig(
  config: CongressConfig,
  sample: typeof CONGRESS_SAMPLES[0],
): Promise<CongressRunResult> {
  const t0 = Date.now();
  const personas: Record<string, string> = {};
  let runningContext = "";

  const personaOrder = ["data_analyst", "copywriter", "academic_proxy", "sales_director", "psychologist", "adversary"];

  for (const key of personaOrder) {
    const base = BASE_PERSONAS[key as keyof typeof BASE_PERSONAS];
    const override = config.personaOverrides[key];
    const text = await runPersona(key, base, override, sample.evidence, runningContext, config.name, config.model);
    personas[key] = text;
    runningContext += `\n\n### ${key.replace("_", " ")}\n${text}`;
  }

  // Synthesizer — uses config-specific instruction
  let recommendation: "approve" | "reject" | "defer" | null = null;
  let confidence: number | null = null;
  let change: { kind: string; details: string } | null = null;
  let rationale: string | null = null;
  const extraFields: Record<string, string> = {};
  let synthText = "";
  let synthTokens: number | null = null;

  try {
    const synthPrompt = `## ${config.name} congress — your role: synthesizer

${config.synthesizer_instruction}

## Evidence pack
${sample.evidence}

## Panel positions
${runningContext}`;

    const r = await llmChat({
      model: config.model,
      user: synthPrompt,
      temperature: 0.3,
      max_tokens: 800,
      json: true,
      timeoutMs: 90_000,
    });
    synthText = r.text?.trim() ?? "";
    synthTokens = r.meta?.tokens_out ?? null;

    const stripped = synthText.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
    const parsed = JSON.parse(stripped);
    recommendation = ["approve", "reject", "defer"].includes(parsed.recommendation) ? parsed.recommendation : null;
    confidence = typeof parsed.confidence === "number" ? parsed.confidence : null;
    if (parsed.change && typeof parsed.change.kind === "string") {
      change = { kind: parsed.change.kind, details: String(parsed.change.details ?? "") };
    }
    rationale = typeof parsed.rationale === "string" ? parsed.rationale : null;
    // Capture config-specific extra fields (key_dissent, scope_note, data_verdict)
    for (const k of ["key_dissent", "scope_note", "data_verdict"] as const) {
      if (typeof parsed[k] === "string") extraFields[k] = parsed[k];
    }
    personas.synthesizer = synthText;
  } catch (e) {
    personas.synthesizer = `(parse failed: ${String(e).slice(0, 80)})`;
  }

  const latency_s = Math.round((Date.now() - t0) / 100) / 10;

  return {
    configId: config.id,
    configName: config.name,
    sampleId: sample.id,
    sampleTitle: sample.title,
    model: config.model,
    personas,
    recommendation,
    confidence,
    change,
    rationale,
    extraFields,
    latency_s,
    tokens_out: synthTokens,
    error: null,
  };
}

// Run all three configs against one evidence pack in parallel.
export async function runAllConfigsOnSample(
  sample: typeof CONGRESS_SAMPLES[0],
  runId: string,
): Promise<CongressRunResult[]> {
  const results = await Promise.allSettled(
    CONGRESS_CONFIGS.map((cfg) => runCongressConfig(cfg, sample)),
  );

  const rows: CongressRunResult[] = results.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    return {
      configId: CONGRESS_CONFIGS[i].id,
      configName: CONGRESS_CONFIGS[i].name,
      sampleId: sample.id,
      sampleTitle: sample.title,
      model: CONGRESS_CONFIGS[i].model,
      personas: {},
      recommendation: null,
      confidence: null,
      change: null,
      rationale: null,
      extraFields: {},
      latency_s: 0,
      tokens_out: null,
      error: String(r.reason).slice(0, 200),
    };
  });

  // Persist to model_bench_runs — one row per config
  await supabase.from("model_bench_runs").insert(
    rows.map((r) => ({
      run_id: runId,
      model: `congress:${r.configId}/${r.model}`,
      task: `congress_config`,
      sample_idx: CONGRESS_SAMPLES.findIndex((s) => s.id === r.sampleId),
      score: r.recommendation === "approve" ? 1.0 : r.recommendation === "reject" ? 0.5 : r.recommendation === "defer" ? 0.3 : 0,
      latency_s: r.latency_s,
      tokens_in: null,
      tokens_out: r.tokens_out,
      output_text: JSON.stringify({
        configId: r.configId,
        configName: r.configName,
        recommendation: r.recommendation,
        confidence: r.confidence,
        change: r.change,
        rationale: r.rationale,
        extraFields: r.extraFields,
        personas: Object.fromEntries(
          Object.entries(r.personas).map(([k, v]) => [k, v.slice(0, 600)])
        ),
      }),
      json_valid: r.recommendation !== null,
      finish_reason: null,
      provider: null,
      error: r.error,
      judges: null,
      judge_avg: null,
      prompt_leak: null,
    })),
  );

  return rows;
}

// ── Legacy single-model scoring (kept for backward compat) ────────────────────
// The old bench ran one model through a single monolithic prompt and scored
// format compliance. Preserved so existing run rows still display correctly.

export interface CongressScore {
  score: number;
  jsonValid: boolean;
  meta: Record<string, unknown>;
}

export async function benchCongressOneModel(model: string, runId: string): Promise<Array<{ score: number; model: string; task: "congress" }>> {
  // Deprecated path — redirect to the new multi-config runner for one sample
  const sample = CONGRESS_SAMPLES[0];
  const results = await runAllConfigsOnSample(sample, runId);
  return results.map((r) => ({
    score: r.recommendation === "approve" ? 1.0 : 0.5,
    model,
    task: "congress" as const,
  }));
}
