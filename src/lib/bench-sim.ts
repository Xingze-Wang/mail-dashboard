// src/lib/bench-sim.ts

import { llmChat } from "@/lib/llm-proxy";
import type {
  CompanyConfig,
  CompanyModelRoster,
  CompanyState,
  StepResult,
  MarketSignal,
  LoopLevel,
} from "@/lib/bench-sim-types";

// ── Base persona definitions (same roles as congress-runners.ts, parameterized) ──

interface PersonaDef {
  key: string;
  display: string;
  system: string;
  question: string;
}

const WEEKLY_BASE_PERSONAS: PersonaDef[] = [
  {
    key: "data_analyst",
    display: "Data Analyst",
    system: "你是 data analyst. 简洁, 用数字, 不下判断, 只报告.",
    question: "What's the single most actionable metric movement in the evidence? Call out sample size, confidence level, and whether the signal is reliable enough to act on.",
  },
  {
    key: "copywriter",
    display: "Copywriter",
    system: "你是销售邮件文案. 关心邮件 prose, subject line, 模板的具体措辞.",
    question: "Given the evidence, what's one prose-level change worth testing? Be specific — exact subject line or exact phrase swap.",
  },
  {
    key: "academic_proxy",
    display: "Academic Proxy",
    system: "你代表收件人 — 一位中国 AI researcher. 你不是 sales, 你是 reader.",
    question: "From the recipient's POV, what's the most off-putting or compelling thing about this proposed change?",
  },
  {
    key: "sales_director",
    display: "Sales Director",
    system: "你是 sales director — 关心 rep 的 workflow + 时间 + 信心.",
    question: "What are the operational consequences for the reps if this change is approved? Who benefits, who bears the cost?",
  },
  {
    key: "psychologist",
    display: "Psychologist",
    system: "你是 psychologist. 你看 emotional/cognitive state — 收件人和 rep 两侧.",
    question: "What emotional response does this change create — in the recipient who receives it, and in the rep who has to execute it?",
  },
  {
    key: "adversary",
    display: "Adversary",
    system: "你的工作是 attack 任何提议的改动. 假设其他 panelist 都太乐观.",
    question: "Read what others said. Pick the strongest implicit proposal and attack it — what's the most likely reason it FAILS?",
  },
];

const MONTHLY_BASE_PERSONAS: PersonaDef[] = [
  {
    key: "historian",
    display: "Historian",
    system: "你是 Historian — 专门 grade 过去的 tactical decisions. 比较 expected 和 actual. 不留情面.",
    question: "For each prior tactical decision in the history: one-line verdict (hit / partial / miss / inconclusive) with the numbers. Then one sentence on overall trajectory.",
  },
  {
    key: "funnel_economist",
    display: "Funnel Economist",
    system: "你是 funnel economist — 看整个漏斗 as a unit. 找 actual bottleneck.",
    question: "Which funnel stage is the bottleneck right now? If you had to pick ONE stage to attack next, which and why?",
  },
  {
    key: "constituent_advocate",
    display: "Constituent Advocate",
    system: "你 speaks for both researcher AND rep as humans. 关心 long-term trust + experience.",
    question: "Beyond metrics, what's degrading or improving in the human experience — for recipients AND reps?",
  },
  {
    key: "psychologist",
    display: "Psychologist",
    system: "你是 psychologist. Strategic horizon. Long-term trust + emotional capital.",
    question: "Are we building or eroding emotional capital with this trajectory? What structural change would address the deepest friction?",
  },
  {
    key: "adversary",
    display: "Adversary",
    system: "你 attack proposed strategic changes. Bigger swings, more skepticism.",
    question: "If the panel proposes a structural change, what's the most likely failure mode? What evidence is missing?",
  },
];

// ── Helper: resolve model for a persona key at a given loop level ──

function resolveModel(roster: CompanyModelRoster, loop: LoopLevel, personaKey: string): string {
  if (loop === "daily") return roster.daily_model;
  if (loop === "quarterly") return roster.quarterly_model;
  if (loop === "weekly") {
    if (personaKey === "synthesizer") return roster.weekly_synth_model;
    return roster.weekly_persona_model[personaKey] ?? roster.weekly_default;
  }
  if (loop === "monthly") {
    if (personaKey === "synthesizer") return roster.monthly_synth_model;
    return roster.monthly_persona_model[personaKey] ?? roster.monthly_default;
  }
  return roster.weekly_default;
}

// ── Helper: apply company persona override ──

function applyOverride(base: PersonaDef, override: { system?: string; question?: string } | undefined): PersonaDef {
  if (!override) return base;
  return { ...base, system: override.system ?? base.system, question: override.question ?? base.question };
}

// ── Helper: build deliberation style modifier for synthesizer ──

function deliberationStyleInstruction(style: CompanyConfig["deliberation_style"]): string {
  switch (style) {
    case "conservative":
      return "Default to 'defer' unless evidence clearly supports action. Bar for approve: sample ≥80 per arm, signal consistent, no adversary critique lands.";
    case "expansionist":
      return "Look for the largest defensible scope of change the evidence can support. If a small change is proposed, consider whether a broader structural change captures more upside.";
    case "empiricist":
      return "Evidence-gated. If data_analyst says INSUFFICIENT, recommendation MUST be 'defer'.";
    case "balanced":
      return "Weigh evidence quality, operational feasibility, and recipient experience equally. Approve when at least two of three are clearly positive.";
  }
}

// ── Helper: build state context string to inject into evidence pack ──

function buildStateContext(state: CompanyState, marketSignals: MarketSignal[]): string {
  const lines: string[] = [];

  if (state.active_directives.length > 0) {
    lines.push("## Active strategic directives (from monthly congress — MUST constrain your proposal)");
    for (const d of state.active_directives) lines.push(`  - ${d}`);
  }

  if (state.postmortem_context) {
    lines.push("## Standing postmortem context (applies until resolved)");
    lines.push(state.postmortem_context);
  }

  if (state.tactical_history.length > 0) {
    lines.push("## Prior tactical decisions this simulation");
    for (const h of state.tactical_history) {
      lines.push(`  Step ${h.step}: "${h.title}" → ${h.recommendation}${h.confidence != null ? ` (${Math.round(h.confidence * 100)}% confidence)` : ""}`);
    }
  }

  if (state.jitr_learnings.length > 0) {
    lines.push("## JITR learnings (daily loop → fed into weekly)");
    for (const l of state.jitr_learnings) lines.push(`  - ${l}`);
  }

  if (marketSignals.length > 0) {
    lines.push("## Market signals (what other organizations have done)");
    for (const s of marketSignals) {
      lines.push(`  [Step ${s.step}] ${s.from_company_name}: ${s.signal}`);
    }
  }

  return lines.join("\n");
}

// ── Core: run one persona ──

async function runSimPersona(
  persona: PersonaDef,
  model: string,
  evidencePack: string,
  stateContext: string,
  runningContext: string,
  companyName: string,
  loopName: string,
): Promise<string> {
  const userPrompt = `## ${companyName} · ${loopName} — your role: ${persona.display}
${persona.question}

## Evidence pack
${evidencePack}
${stateContext ? `\n## Company context\n${stateContext}` : ""}
${runningContext ? `\n## What the panel has said so far\n${runningContext}` : ""}

200 words max. Cite specifics from the evidence. Don't repeat what others said — push back, refine, or add what's missing.`;

  try {
    const r = await llmChat({
      model,
      system: persona.system,
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

// ── Core: run synthesizer ──

async function runSimSynthesizer(
  model: string,
  style: CompanyConfig["deliberation_style"],
  personaContext: string,
  evidencePack: string,
  companyName: string,
  loopName: string,
  extraJsonFields: string,
): Promise<{ text: string; parsed: Record<string, unknown> | null; tokensOut: number | null }> {
  const prompt = `## ${companyName} · ${loopName} — your role: Synthesizer

${deliberationStyleInstruction(style)}

${extraJsonFields}

## Evidence pack
${evidencePack}

## Panel positions
${personaContext}`;

  try {
    const r = await llmChat({
      model,
      user: prompt,
      temperature: 0.3,
      max_tokens: 800,
      json: true,
      timeoutMs: 90_000,
    });
    const text = r.text?.trim() ?? "";
    const stripped = text.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
    try {
      const parsed = JSON.parse(stripped);
      return { text, parsed, tokensOut: r.meta?.tokens_out ?? null };
    } catch {
      return { text, parsed: null, tokensOut: null };
    }
  } catch (err) {
    return { text: `(errored: ${String(err).slice(0, 80)})`, parsed: null, tokensOut: null };
  }
}

// ── Public: run weekly loop for one company at one step ──

// Maximum debate exchanges after the initial round-1 positions. The chair
// decides each round whether to keep going. Hard cap so a stuck panel
// doesn't run forever — the synthesizer makes a call regardless at this point.
const MAX_DEBATE_EXCHANGES = 4;

interface DebateExchange {
  speaker: string;        // persona key
  speaker_label: string;
  message: string;
  responding_to?: string; // persona key being addressed
}

export async function runCompanyWeeklyStep(
  company: CompanyConfig,
  evidencePack: string,
  state: CompanyState,
  marketSignals: MarketSignal[],
): Promise<StepResult> {
  const t0 = Date.now();
  const stateContext = buildStateContext(state, marketSignals);
  const personas: Record<string, string> = {};
  const debate: DebateExchange[] = [];
  let runningContext = "";

  // ── Round 1: position papers — 5 non-adversary personas in parallel.
  const positionPersonas = WEEKLY_BASE_PERSONAS.filter((p) => p.key !== "adversary");
  const positionResults = await Promise.all(positionPersonas.map(async (baseDef) => {
    const override = company.persona_overrides[baseDef.key];
    const def = applyOverride(baseDef, override);
    const model = resolveModel(company.model_roster, "weekly", def.key);
    const text = await runSimPersona(def, model, evidencePack, stateContext, "", company.name, "Weekly Tactical · Round 1");
    return { key: def.key, display: def.display, text };
  }));
  for (const r of positionResults) {
    personas[r.key] = r.text;
    runningContext += `\n\n### ${r.display}\n${r.text}`;
  }

  // ── Adversary opens round 2 with an attack on the weakest position.
  const adversaryDef = applyOverride(
    WEEKLY_BASE_PERSONAS.find((p) => p.key === "adversary")!,
    company.persona_overrides["adversary"],
  );
  const adversaryModel = resolveModel(company.model_roster, "weekly", "adversary");
  let attackTarget = "data_analyst";
  let attackMessage = "";
  try {
    const r = await llmChat({
      model: adversaryModel,
      system: adversaryDef.system,
      user: `## ${company.name} · Weekly Tactical · Round 2 — your role: Adversary

${adversaryDef.question}

Format JSON: { "attacks_persona": one of "data_analyst"|"copywriter"|"academic_proxy"|"sales_director"|"psychologist", "message": "your attack — 2-3 sentences, specific" }

## Evidence pack
${evidencePack}
${stateContext ? `\n## Company context\n${stateContext}` : ""}

## Round 1 positions
${runningContext}

JSON only.`,
      temperature: 0.6,
      max_tokens: 500,
      json: true,
      timeoutMs: 60_000,
    });
    const stripped = (r.text ?? "").replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
    try {
      const parsed = JSON.parse(stripped);
      if (typeof parsed.attacks_persona === "string" && positionPersonas.some((p) => p.key === parsed.attacks_persona)) {
        attackTarget = parsed.attacks_persona;
      }
      attackMessage = typeof parsed.message === "string" ? parsed.message : (r.text ?? "");
    } catch {
      attackMessage = r.text ?? "";
    }
  } catch (err) {
    attackMessage = `(adversary errored: ${String(err).slice(0, 80)})`;
  }
  personas["adversary"] = attackMessage;
  debate.push({ speaker: "adversary", speaker_label: "Adversary", message: attackMessage, responding_to: attackTarget });
  runningContext += `\n\n### Adversary (attacks ${attackTarget})\n${attackMessage}`;

  // ── Dynamic debate loop — the chair (synthesizer model) decides each
  // turn whether to keep going. Stops when the chair calls "concluded",
  // when the same speaker would be called twice in a row, or at MAX cap.
  const synthModel = resolveModel(company.model_roster, "weekly", "synthesizer");
  let lastSpeaker = "adversary";
  for (let i = 0; i < MAX_DEBATE_EXCHANGES; i++) {
    // Chair picks: continue + who speaks + responding to whom, or conclude.
    let chairDecision: { action: "continue" | "conclude"; next_speaker?: string; addresses?: string; reason: string } | null = null;
    try {
      const r = await llmChat({
        model: synthModel,
        system: "You are the meeting chair. You decide whether the panel has reached enough understanding to conclude, or whether one more exchange would change the recommendation. Stop quickly if positions are converging or repeating.",
        user: `## ${company.name} · Weekly Tactical — Chair's decision

The panel has spoken. Decide: should one more persona speak (responding to what's been said), or should we conclude and write the memo now?

Stop conditions (any one):
- Positions are clearly converging
- Same arguments are repeating
- New evidence wouldn't change the call
- ${MAX_DEBATE_EXCHANGES - i} more exchanges remaining is enough

Continue conditions:
- A persona was attacked and hasn't responded
- Two personas hold contradictory views and neither has engaged the other
- One specific question is unresolved and would change the recommendation

Format JSON: {
  "action": "continue" | "conclude",
  "next_speaker": null | one of "data_analyst" | "copywriter" | "academic_proxy" | "sales_director" | "psychologist" | "adversary",
  "addresses": null | persona key the speaker is responding to,
  "reason": "1 short sentence why"
}

## Transcript so far
${runningContext}

JSON only.`,
        temperature: 0.2,
        max_tokens: 220,
        json: true,
        timeoutMs: 45_000,
      });
      const stripped = (r.text ?? "").replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
      try {
        chairDecision = JSON.parse(stripped);
      } catch { /* fall through */ }
    } catch { /* fall through */ }

    if (!chairDecision || chairDecision.action === "conclude" || !chairDecision.next_speaker) break;
    if (chairDecision.next_speaker === lastSpeaker) break;          // never two-in-a-row
    if (chairDecision.next_speaker === "adversary" && lastSpeaker === "adversary") break;

    const speakerKey = chairDecision.next_speaker;
    const allPersonas = [...WEEKLY_BASE_PERSONAS];
    const speakerBase = allPersonas.find((p) => p.key === speakerKey);
    if (!speakerBase) break;
    const speakerDef = applyOverride(speakerBase, company.persona_overrides[speakerKey]);
    const speakerModel = resolveModel(company.model_roster, "weekly", speakerKey);
    const addresses = chairDecision.addresses ?? lastSpeaker;
    const addressedText = personas[addresses] ?? "";

    let exchangeText = "";
    try {
      const r = await llmChat({
        model: speakerModel,
        system: speakerDef.system,
        user: `## ${company.name} · Weekly Tactical · Round ${3 + i} — you are the ${speakerDef.display}

The chair has called on you to respond. ${chairDecision.reason ?? ""}

You are responding to ${addresses}. Their position: "${addressedText.slice(0, 600)}"

Steelman their point first, then either refine, concede, or push back. 120 words max. Don't repeat what's already in the transcript — add new substance.

## Transcript
${runningContext}`,
        temperature: 0.5,
        max_tokens: 400,
        timeoutMs: 60_000,
      });
      exchangeText = r.text?.trim() ?? "";
    } catch (err) {
      exchangeText = `(${speakerDef.display} errored: ${String(err).slice(0, 80)})`;
    }

    debate.push({
      speaker: speakerKey,
      speaker_label: speakerDef.display,
      message: exchangeText,
      responding_to: addresses,
    });
    runningContext += `\n\n### ${speakerDef.display} (responds to ${addresses})\n${exchangeText}`;
    lastSpeaker = speakerKey;
  }

  // ── Synthesizer writes the memo.
  const extraJson = `Produce JSON: { "title":"one-line summary", "recommendation":"approve"|"reject"|"defer", "confidence":0.0-1.0, "change":{"kind":"subject_line_test"|"template_phrase_swap"|"routing_tweak"|"copy_edit"|"scope_expansion","details":"exact change in plain language"}, "rationale":"2 sentences — why", "key_dissent":"strongest adversary point" }
JSON only.`;

  const { text: synthText, parsed, tokensOut } = await runSimSynthesizer(
    synthModel, company.deliberation_style, runningContext, evidencePack, company.name, "Weekly Tactical", extraJson,
  );
  personas["synthesizer"] = synthText;

  const recommendation = parsed && ["approve", "reject", "defer"].includes(parsed.recommendation as string)
    ? (parsed.recommendation as "approve" | "reject" | "defer") : null;
  const confidence = parsed && typeof parsed.confidence === "number" ? parsed.confidence : null;
  const change = parsed?.change && typeof (parsed.change as Record<string, unknown>).kind === "string"
    ? { kind: String((parsed.change as Record<string, unknown>).kind), details: String((parsed.change as Record<string, unknown>).details ?? "") }
    : null;
  const rationale = parsed && typeof parsed.rationale === "string" ? parsed.rationale : null;

  // Persist debate exchanges in extra_fields. The minutes drawer renders
  // them in order, with each exchange showing who spoke and to whom.
  const extra_fields: Record<string, unknown> = {
    debate,
    // Back-compat: timeline minutes also reads `attacks` for round-2.
    attacks: debate.length > 0 ? [{
      attacks_persona: debate[0].responding_to ?? "data_analyst",
      message: debate[0].message,
      rebuttal: debate.length > 1 ? { by_persona: debate[1].speaker, message: debate[1].message } : undefined,
    }] : [],
  };
  for (const k of ["key_dissent", "scope_note", "data_verdict"] as const) {
    if (parsed && typeof parsed[k] === "string") extra_fields[k] = parsed[k] as string;
  }

  void tokensOut;

  return {
    company_id: company.id,
    session_id: state.session_id,
    step: state.step,
    loop: "weekly",
    personas,
    recommendation,
    confidence,
    change,
    rationale,
    extra_fields: extra_fields as Record<string, string>,
    latency_s: Math.round((Date.now() - t0) / 100) / 10,
    error: null,
  };
}

// ── Public: run monthly loop for one company ──

export async function runCompanyMonthlyStep(
  company: CompanyConfig,
  evidencePack: string,
  state: CompanyState,
  marketSignals: MarketSignal[],
): Promise<StepResult> {
  const t0 = Date.now();
  const stateContext = buildStateContext(state, marketSignals);
  const personas: Record<string, string> = {};
  let runningContext = "";

  for (const baseDef of MONTHLY_BASE_PERSONAS) {
    const override = company.persona_overrides[baseDef.key];
    const def = applyOverride(baseDef, override);
    const model = resolveModel(company.model_roster, "monthly", def.key);
    const text = await runSimPersona(def, model, evidencePack, stateContext, runningContext, company.name, "Monthly Strategic");
    personas[def.key] = text;
    runningContext += `\n\n### ${def.display}\n${text}`;
  }

  const synthModel = resolveModel(company.model_roster, "monthly", "synthesizer");
  const extraJson = `Produce JSON: { "title":"one-line summary", "recommendation":"approve"|"reject"|"defer", "confidence":0.0-1.0, "change":{"kind":"routing_tweak"|"template_phrase_swap"|"scope_expansion"|"copy_edit","details":"exact change"}, "rationale":"2 sentences", "directive":"if approve — one-paragraph strategic directive that constrains future weekly loops", "historian_grade":"net positive|net zero|net negative" }
JSON only.`;

  const { text: synthText, parsed, tokensOut } = await runSimSynthesizer(
    synthModel, company.deliberation_style, runningContext, evidencePack, company.name, "Monthly Strategic", extraJson,
  );
  personas["synthesizer"] = synthText;

  const recommendation = parsed && ["approve", "reject", "defer"].includes(parsed.recommendation as string)
    ? (parsed.recommendation as "approve" | "reject" | "defer") : null;
  const confidence = parsed && typeof parsed.confidence === "number" ? parsed.confidence : null;
  const change = parsed?.change && typeof (parsed.change as Record<string, unknown>).kind === "string"
    ? { kind: String((parsed.change as Record<string, unknown>).kind), details: String((parsed.change as Record<string, unknown>).details ?? "") }
    : null;
  const rationale = parsed && typeof parsed.rationale === "string" ? parsed.rationale : null;
  const extra_fields: Record<string, string> = {};
  if (parsed && typeof parsed.directive === "string") extra_fields["directive"] = parsed.directive;
  if (parsed && typeof parsed.historian_grade === "string") extra_fields["historian_grade"] = parsed.historian_grade;

  void tokensOut;

  return {
    company_id: company.id,
    session_id: state.session_id,
    step: state.step,
    loop: "monthly",
    personas,
    recommendation,
    confidence,
    change,
    rationale,
    extra_fields,
    latency_s: Math.round((Date.now() - t0) / 100) / 10,
    error: null,
  };
}

// ── Public: extract market signal from a step result (for cross-company visibility) ──

export function extractMarketSignal(result: StepResult, companyName: string): MarketSignal | null {
  if (!result.recommendation || !result.change) return null;
  const signal = `${result.recommendation} — ${result.change.details.slice(0, 120)}${result.confidence != null ? ` (${Math.round(result.confidence * 100)}% confidence)` : ""}`;
  return { from_company_name: companyName, step: result.step, signal };
}

// ── Public: update company state after a step result ──

export function advanceCompanyState(state: CompanyState, result: StepResult): CompanyState {
  const next: CompanyState = {
    ...state,
    step: state.step + 1,
    tactical_history: [...state.tactical_history],
    active_directives: [...state.active_directives],
    jitr_learnings: [...state.jitr_learnings],
  };

  if (result.loop === "weekly" && result.recommendation && result.change) {
    next.tactical_history.push({
      step: result.step,
      title: result.change.details.slice(0, 80),
      recommendation: result.recommendation,
      confidence: result.confidence,
    });
  }

  if (result.loop === "monthly" && result.recommendation === "approve" && result.extra_fields.directive) {
    next.active_directives.push(result.extra_fields.directive);
  }

  return next;
}
