# Congress Company Simulation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a congress simulation bench where N user-defined "companies" — each with its own full four-loop congress architecture, distinct model rosters per persona and loop level, and deliberation style — run through the same scenario sequence, with each loop's decisions feeding forward into the next, and companies able to observe each other's moves as market signals.

**Architecture:** Company definitions live in Supabase (`bench_companies` table) so they persist across sessions and can be edited in-UI. Each simulation session (`bench_sim_sessions`) sequences through weekly steps; per-company state (`bench_company_states`) carries the feedforward context (active directives, tactical history, postmortem standing text) that gets injected into each subsequent loop prompt. The simulation engine is a thin parameterization layer over the existing `congress-runners.ts` personas and synthesizer logic — it swaps in per-company model rosters and injects company state rather than querying live DB metrics, so the same personas work for both real cron loops and simulation.

**Tech Stack:** Next.js 16, TypeScript, Supabase (postgres), `src/lib/llm-proxy.ts` (llmChat), existing `congress-runners.ts` persona logic as reference (do not import directly — parameterize separately in sim engine).

**Customer-fit layer:** Each company config includes a `customer_profile` field (e.g. `{ segment: "top_tier_academia" | "mid_tier_startup" | "gov_lab", communication_style: "formal" | "direct" | "relationship_first" }`) so after running simulations you can see which congress architecture produced best outcomes for which customer type — directly informing which congress config to deploy per customer segment.

---

## File Map

### New files
- `src/lib/bench-sim.ts` — simulation engine: parameterized persona runner, feedforward state builder, per-company loop orchestration
- `src/lib/bench-sim-types.ts` — all TypeScript types for companies, sessions, states, step results
- `src/app/api/bench/sim/route.ts` — REST API: CRUD for companies + session management + step execution
- `src/app/api/bench/sim/[sessionId]/route.ts` — GET session detail + DELETE
- `src/app/bench/sim/page.tsx` — company setup UI + simulation dashboard (timeline + drill-down)
- `src/components/bench/SimTimeline.tsx` — the horizontal timeline grid (companies × steps × divergence)
- `src/components/bench/CompanyCard.tsx` — company definition display/edit card
- `src/components/bench/StepDrillDown.tsx` — full persona transcript for one company × one step

### Modified files
- `src/app/bench/page.tsx` — add "Simulation" tab alongside Writer and Congress tabs
- (No changes to congress-runners.ts, bench-congress.ts, or any existing API)

---

## Task 1: Types

**Files:**
- Create: `src/lib/bench-sim-types.ts`

- [ ] **Step 1: Write the types file**

```typescript
// src/lib/bench-sim-types.ts

export type LoopLevel = "daily" | "weekly" | "monthly" | "quarterly";

export type CustomerSegment = "top_tier_academia" | "mid_tier_startup" | "gov_lab" | "industry_research" | "unknown";
export type CommunicationStyle = "formal" | "direct" | "relationship_first";

// Per-persona model assignment within a loop level
export type PersonaModelMap = Record<string, string>; // personaKey → model id

// Model roster for a company: which model runs which role at which loop level
export interface CompanyModelRoster {
  daily_model: string;           // JITR persona model
  weekly_persona_model: PersonaModelMap;  // key → model (falls back to weekly_default)
  weekly_default: string;        // default for personas not in the map
  weekly_synth_model: string;    // synthesizer model for weekly loop
  monthly_persona_model: PersonaModelMap;
  monthly_default: string;
  monthly_synth_model: string;
  quarterly_model: string;       // postmortem uses one model
}

// Persona override: change system prompt or question for a specific persona
export interface PersonaOverride {
  system?: string;
  question?: string;
}

export interface CompanyConfig {
  id: string;                    // uuid, set by DB
  name: string;                  // "Aggressive Startup", "Conservative Fund", etc.
  tagline: string;               // one-line description
  deliberation_style: "conservative" | "expansionist" | "empiricist" | "balanced";
  model_roster: CompanyModelRoster;
  persona_overrides: Partial<Record<string, PersonaOverride>>; // personaKey → override
  customer_profile: {
    segment: CustomerSegment;
    communication_style: CommunicationStyle;
  };
  color: string;                 // hex color for UI differentiation
  created_at: string;
}

// Feedforward state for one company at one point in simulation time
export interface CompanyState {
  company_id: string;
  session_id: string;
  step: number;                  // which time step this state is after
  active_directives: string[];   // from monthly congress approvals
  postmortem_context: string | null;  // standing text if postmortem fired
  tactical_history: Array<{
    step: number;
    title: string;
    recommendation: string;
    confidence: number | null;
  }>;
  jitr_learnings: string[];      // daily loop learnings that feed weekly
}

// Result of running one company through one loop at one step
export interface StepResult {
  company_id: string;
  session_id: string;
  step: number;
  loop: LoopLevel;
  personas: Record<string, string>;    // personaKey → response text
  recommendation: "approve" | "reject" | "defer" | null;
  confidence: number | null;
  change: { kind: string; details: string } | null;
  rationale: string | null;
  extra_fields: Record<string, string>;
  latency_s: number;
  error: string | null;
}

// One step in a simulation session (all companies run their loops)
export interface SimStep {
  step: number;
  evidence_title: string;
  evidence_body: string;
  loops_run: LoopLevel[];         // which loops ran this step
  results: StepResult[];          // one per company × loop
}

// A full simulation session
export interface SimSession {
  id: string;
  name: string;
  scenario_id: string;            // which evidence scenario set
  company_ids: string[];
  steps_planned: number;
  steps_completed: number;
  cross_company_visibility: boolean;  // do companies see each other's decisions?
  status: "pending" | "running" | "paused" | "complete" | "error";
  created_at: string;
  steps: SimStep[];
}

// Market signal: what one company sees about another (cross-company observation)
export interface MarketSignal {
  from_company_name: string;
  step: number;
  signal: string;  // e.g. "Competitor switched to question subject lines (approved, 78% confidence)"
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/bench-sim-types.ts
git commit -m "feat(sim): add company simulation type definitions"
```

---

## Task 2: Simulation engine

**Files:**
- Create: `src/lib/bench-sim.ts`

This is the core. It parameterizes the existing persona pattern from `congress-runners.ts` without importing it — same structure, but model and prompts come from `CompanyConfig` instead of hardcoded values.

- [ ] **Step 1: Write bench-sim.ts**

```typescript
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

export async function runCompanyWeeklyStep(
  company: CompanyConfig,
  evidencePack: string,
  state: CompanyState,
  marketSignals: MarketSignal[],
): Promise<StepResult> {
  const t0 = Date.now();
  const stateContext = buildStateContext(state, marketSignals);
  const personas: Record<string, string> = {};
  let runningContext = "";

  const personaOrder = WEEKLY_BASE_PERSONAS;
  for (const baseDef of personaOrder) {
    const override = company.persona_overrides[baseDef.key];
    const def = applyOverride(baseDef, override);
    const model = resolveModel(company.model_roster, "weekly", def.key);
    const text = await runSimPersona(def, model, evidencePack, stateContext, runningContext, company.name, "Weekly Tactical");
    personas[def.key] = text;
    runningContext += `\n\n### ${def.display}\n${text}`;
  }

  // Synthesizer
  const synthModel = resolveModel(company.model_roster, "weekly", "synthesizer");
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
  const extra_fields: Record<string, string> = {};
  for (const k of ["key_dissent", "scope_note", "data_verdict"] as const) {
    if (parsed && typeof parsed[k] === "string") extra_fields[k] = parsed[k] as string;
  }

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
    extra_fields,
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
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/bench-sim.ts
git commit -m "feat(sim): add parameterized simulation engine with feedforward state"
```

---

## Task 3: Database migration

**Files:**
- Create: `migrations/038-bench-sim.sql`
- Create: `scripts/apply-038.mjs`

- [ ] **Step 1: Write the migration SQL**

```sql
-- migrations/038-bench-sim.sql
-- 1. SCHEMA CHANGE: add bench_companies, bench_sim_sessions, bench_company_states, bench_step_results tables
-- 2. WHO WRITES: bench simulation API (POST /api/bench/sim)
-- 3. WHO READS: bench simulation API (GET /api/bench/sim), simulation dashboard
-- 4. BACKFILL: none — new tables

create table if not exists bench_companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  tagline text not null default '',
  deliberation_style text not null default 'balanced',
  model_roster jsonb not null default '{}',
  persona_overrides jsonb not null default '{}',
  customer_profile jsonb not null default '{}',
  color text not null default '#6366f1',
  created_at timestamptz not null default now()
);

create table if not exists bench_sim_sessions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  scenario_id text not null,
  company_ids uuid[] not null default '{}',
  steps_planned int not null default 4,
  steps_completed int not null default 0,
  cross_company_visibility boolean not null default true,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create table if not exists bench_company_states (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references bench_sim_sessions(id) on delete cascade,
  company_id uuid not null references bench_companies(id) on delete cascade,
  step int not null,
  state jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique(session_id, company_id, step)
);

create table if not exists bench_step_results (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references bench_sim_sessions(id) on delete cascade,
  company_id uuid not null references bench_companies(id) on delete cascade,
  step int not null,
  loop text not null,
  personas jsonb not null default '{}',
  recommendation text,
  confidence float,
  change_spec jsonb,
  rationale text,
  extra_fields jsonb not null default '{}',
  latency_s float,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists bench_step_results_session_step on bench_step_results(session_id, step);
```

- [ ] **Step 2: Write the apply script**

```javascript
// scripts/apply-038.mjs
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(resolve(__dirname, "../migrations/038-bench-sim.sql"), "utf8");

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY"); process.exit(1); }

const res = await fetch(`${url}/rest/v1/rpc/exec_sql`, {
  method: "POST",
  headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` },
  body: JSON.stringify({ sql }),
});

if (!res.ok) {
  // Fallback: use the SQL editor endpoint
  const res2 = await fetch(`${url}/rest/v1/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}`, "Prefer": "return=minimal" },
    body: sql,
  });
  if (!res2.ok) { console.error("Migration failed", await res2.text()); process.exit(1); }
}
console.log("Migration 038 applied.");
```

- [ ] **Step 3: Apply locally**

```bash
node scripts/apply-038.mjs
```

Expected: `Migration 038 applied.`

- [ ] **Step 4: Commit**

```bash
git add migrations/038-bench-sim.sql scripts/apply-038.mjs
git commit -m "feat(sim): add bench simulation DB tables (038)"
```

---

## Task 4: REST API

**Files:**
- Create: `src/app/api/bench/sim/route.ts`
- Create: `src/app/api/bench/sim/[sessionId]/route.ts`

- [ ] **Step 1: Write the main route**

```typescript
// src/app/api/bench/sim/route.ts

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";
import {
  runCompanyWeeklyStep,
  runCompanyMonthlyStep,
  extractMarketSignal,
  advanceCompanyState,
} from "@/lib/bench-sim";
import type { CompanyConfig, CompanyState, SimSession, StepResult, MarketSignal } from "@/lib/bench-sim-types";
import { CONGRESS_SAMPLES } from "@/lib/bench-congress";

export const maxDuration = 300;

// GET /api/bench/sim → list companies + sessions
export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const [{ data: companies }, { data: sessions }] = await Promise.all([
    supabase.from("bench_companies").select("*").order("created_at", { ascending: false }),
    supabase.from("bench_sim_sessions").select("*").order("created_at", { ascending: false }).limit(20),
  ]);

  return NextResponse.json({ companies: companies ?? [], sessions: sessions ?? [] });
}

// POST /api/bench/sim with action in body:
//   { action: "create_company", company: CompanyConfig }
//   { action: "create_session", name, scenario_id, company_ids, steps_planned, cross_company_visibility }
//   { action: "run_step", session_id }  ← advances session by one step
export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const body = await req.json().catch(() => ({}));
  const { action } = body;

  if (action === "create_company") {
    const { company } = body;
    if (!company?.name || !company?.model_roster) {
      return NextResponse.json({ error: "company.name and company.model_roster required" }, { status: 400 });
    }
    const { data, error } = await supabase.from("bench_companies").insert({
      name: company.name,
      tagline: company.tagline ?? "",
      deliberation_style: company.deliberation_style ?? "balanced",
      model_roster: company.model_roster,
      persona_overrides: company.persona_overrides ?? {},
      customer_profile: company.customer_profile ?? {},
      color: company.color ?? "#6366f1",
    }).select().single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ company: data });
  }

  if (action === "create_session") {
    const { name, scenario_id, company_ids, steps_planned, cross_company_visibility } = body;
    if (!name || !scenario_id || !company_ids?.length) {
      return NextResponse.json({ error: "name, scenario_id, company_ids required" }, { status: 400 });
    }
    const { data, error } = await supabase.from("bench_sim_sessions").insert({
      name,
      scenario_id,
      company_ids,
      steps_planned: steps_planned ?? 4,
      cross_company_visibility: cross_company_visibility ?? true,
      status: "pending",
    }).select().single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ session: data });
  }

  if (action === "run_step") {
    const { session_id } = body;
    if (!session_id) return NextResponse.json({ error: "session_id required" }, { status: 400 });

    // Load session
    const { data: session } = await supabase.from("bench_sim_sessions").select("*").eq("id", session_id).single();
    if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });
    if (session.status === "complete") return NextResponse.json({ error: "session already complete" }, { status: 400 });

    const step = session.steps_completed as number;
    const loopsThisStep: Array<"weekly" | "monthly"> = ["weekly"];
    if ((step + 1) % 4 === 0) loopsThisStep.push("monthly"); // monthly every 4 weekly steps

    // Load companies
    const { data: companyRows } = await supabase.from("bench_companies").select("*").in("id", session.company_ids as string[]);
    const companies = (companyRows ?? []) as CompanyConfig[];

    // Load or initialize states for each company
    const stateMap = new Map<string, CompanyState>();
    for (const company of companies) {
      const { data: stateRow } = await supabase
        .from("bench_company_states")
        .select("state")
        .eq("session_id", session_id)
        .eq("company_id", company.id)
        .eq("step", step - 1)
        .single();

      const state: CompanyState = stateRow?.state ?? {
        company_id: company.id,
        session_id,
        step,
        active_directives: [],
        postmortem_context: null,
        tactical_history: [],
        jitr_learnings: [],
      };
      state.step = step;
      stateMap.set(company.id, state);
    }

    // Load evidence pack for this step (cycle through CONGRESS_SAMPLES)
    const sampleIdx = step % CONGRESS_SAMPLES.length;
    const sample = CONGRESS_SAMPLES[sampleIdx];

    // Collect prior market signals from this session
    const priorSignals: MarketSignal[] = [];
    if (session.cross_company_visibility) {
      const { data: priorResults } = await supabase
        .from("bench_step_results")
        .select("*")
        .eq("session_id", session_id)
        .eq("loop", "weekly")
        .lt("step", step);

      for (const pr of priorResults ?? []) {
        const co = companies.find((c) => c.id === pr.company_id);
        if (!co) continue;
        const partialResult: StepResult = {
          company_id: pr.company_id,
          session_id,
          step: pr.step,
          loop: pr.loop as "weekly",
          personas: pr.personas ?? {},
          recommendation: pr.recommendation as StepResult["recommendation"],
          confidence: pr.confidence,
          change: pr.change_spec as StepResult["change"],
          rationale: pr.rationale,
          extra_fields: pr.extra_fields ?? {},
          latency_s: pr.latency_s ?? 0,
          error: pr.error,
        };
        const sig = extractMarketSignal(partialResult, co.name);
        if (sig) priorSignals.push(sig);
      }
    }

    // Mark session running
    await supabase.from("bench_sim_sessions").update({ status: "running" }).eq("id", session_id);

    // Run all companies in parallel for each loop
    const allResults: StepResult[] = [];

    for (const loop of loopsThisStep) {
      const loopResults = await Promise.allSettled(
        companies.map(async (company) => {
          const state = stateMap.get(company.id)!;
          // For weekly loop, pass only prior steps' signals. For monthly, pass all.
          const signals = session.cross_company_visibility ? priorSignals : [];
          if (loop === "weekly") {
            return runCompanyWeeklyStep(company, sample.evidence, state, signals);
          } else {
            return runCompanyMonthlyStep(company, sample.evidence, state, signals);
          }
        }),
      );

      for (let i = 0; i < loopResults.length; i++) {
        const company = companies[i];
        const settled = loopResults[i];
        const result: StepResult = settled.status === "fulfilled"
          ? settled.value
          : {
              company_id: company.id,
              session_id,
              step,
              loop,
              personas: {},
              recommendation: null,
              confidence: null,
              change: null,
              rationale: null,
              extra_fields: {},
              latency_s: 0,
              error: String((settled as PromiseRejectedResult).reason).slice(0, 200),
            };
        allResults.push(result);
      }
    }

    // Persist results
    await supabase.from("bench_step_results").insert(
      allResults.map((r) => ({
        session_id,
        company_id: r.company_id,
        step: r.step,
        loop: r.loop,
        personas: r.personas,
        recommendation: r.recommendation,
        confidence: r.confidence,
        change_spec: r.change,
        rationale: r.rationale,
        extra_fields: r.extra_fields,
        latency_s: r.latency_s,
        error: r.error,
      })),
    );

    // Advance states
    for (const company of companies) {
      const state = stateMap.get(company.id)!;
      const weeklyResult = allResults.find((r) => r.company_id === company.id && r.loop === "weekly");
      const monthlyResult = allResults.find((r) => r.company_id === company.id && r.loop === "monthly");
      let nextState = weeklyResult ? advanceCompanyState(state, weeklyResult) : state;
      if (monthlyResult) nextState = advanceCompanyState(nextState, monthlyResult);

      await supabase.from("bench_company_states").upsert({
        session_id,
        company_id: company.id,
        step,
        state: nextState,
      }, { onConflict: "session_id,company_id,step" });
    }

    // Advance session step counter
    const nextStepCount = step + 1;
    const isDone = nextStepCount >= (session.steps_planned as number);
    await supabase.from("bench_sim_sessions").update({
      steps_completed: nextStepCount,
      status: isDone ? "complete" : "paused",
    }).eq("id", session_id);

    return NextResponse.json({
      step,
      results: allResults,
      done: isDone,
    });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
```

- [ ] **Step 2: Write the session detail route**

```typescript
// src/app/api/bench/sim/[sessionId]/route.ts

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";

export async function GET(req: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const { sessionId } = await params;

  const [{ data: session }, { data: results }, { data: companies }] = await Promise.all([
    supabase.from("bench_sim_sessions").select("*").eq("id", sessionId).single(),
    supabase.from("bench_step_results").select("*").eq("session_id", sessionId).order("step").order("loop"),
    supabase.from("bench_companies").select("*"),
  ]);

  if (!session) return NextResponse.json({ error: "not found" }, { status: 404 });

  return NextResponse.json({ session, results: results ?? [], companies: companies ?? [] });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const { sessionId } = await params;
  await supabase.from("bench_sim_sessions").delete().eq("id", sessionId);
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3: Commit**

```bash
git add src/app/api/bench/sim/route.ts src/app/api/bench/sim/[sessionId]/route.ts
git commit -m "feat(sim): add bench simulation REST API with feedforward step runner"
```

---

## Task 5: CompanyCard component

**Files:**
- Create: `src/components/bench/CompanyCard.tsx`

- [ ] **Step 1: Write CompanyCard**

```typescript
// src/components/bench/CompanyCard.tsx
"use client";

import type { CompanyConfig } from "@/lib/bench-sim-types";

const STYLE_LABEL: Record<string, string> = {
  conservative: "Conservative",
  expansionist: "Expansionist",
  empiricist: "Empiricist",
  balanced: "Balanced",
};

const SEGMENT_LABEL: Record<string, string> = {
  top_tier_academia: "Top-tier academia",
  mid_tier_startup: "Mid-tier startup",
  gov_lab: "Gov lab",
  industry_research: "Industry research",
  unknown: "Unknown",
};

export function CompanyCard({ company, selected, onSelect }: {
  company: CompanyConfig;
  selected: boolean;
  onSelect?: () => void;
}) {
  const roster = company.model_roster;

  return (
    <div
      onClick={onSelect}
      className={`rounded-xl border bg-white p-4 dark:bg-zinc-900 transition-all cursor-pointer ${
        selected
          ? "border-sky-400 ring-2 ring-sky-200 dark:border-sky-600 dark:ring-sky-900"
          : "border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700"
      }`}
      style={{ borderLeftColor: company.color, borderLeftWidth: 4 }}
    >
      <div className="mb-1 flex items-center justify-between">
        <div className="text-[13px] font-semibold">{company.name}</div>
        <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
          {STYLE_LABEL[company.deliberation_style] ?? company.deliberation_style}
        </span>
      </div>
      <div className="mb-2 text-[11px] text-zinc-500 dark:text-zinc-400">{company.tagline}</div>

      {/* Model roster summary */}
      <div className="mb-2 space-y-0.5">
        <div className="text-[10px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">Models</div>
        <div className="flex flex-wrap gap-1">
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[9px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
            W·synth: {roster.weekly_synth_model}
          </span>
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[9px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
            W·default: {roster.weekly_default}
          </span>
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[9px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
            M·synth: {roster.monthly_synth_model}
          </span>
        </div>
      </div>

      {/* Customer profile */}
      {company.customer_profile?.segment && (
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-zinc-400 dark:text-zinc-500">Best for:</span>
          <span className="rounded bg-violet-50 px-1.5 py-0.5 text-[10px] text-violet-700 dark:bg-violet-950 dark:text-violet-300">
            {SEGMENT_LABEL[company.customer_profile.segment] ?? company.customer_profile.segment}
          </span>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/bench/CompanyCard.tsx
git commit -m "feat(sim): add CompanyCard component"
```

---

## Task 6: SimTimeline component

**Files:**
- Create: `src/components/bench/SimTimeline.tsx`

This is the main visualization: companies on rows, steps on columns, cells colored by recommendation, divergence highlighted.

- [ ] **Step 1: Write SimTimeline**

```typescript
// src/components/bench/SimTimeline.tsx
"use client";

import type { CompanyConfig, StepResult } from "@/lib/bench-sim-types";

interface Props {
  companies: CompanyConfig[];
  results: StepResult[];
  stepsCompleted: number;
  onCellClick: (companyId: string, step: number, loop: string) => void;
  activeCell: { companyId: string; step: number; loop: string } | null;
}

const REC_COLOR: Record<string, string> = {
  approve: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
  reject:  "bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300",
  defer:   "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
};

export function SimTimeline({ companies, results, stepsCompleted, onCellClick, activeCell }: Props) {
  const steps = Array.from({ length: stepsCompleted }, (_, i) => i);

  if (steps.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-6 text-center text-[13px] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
        No steps run yet. Click "Run next step" to start.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full border-collapse text-[12px]">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-white px-3 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-zinc-400 dark:bg-zinc-950 dark:text-zinc-500 w-36">
              Company
            </th>
            {steps.map((s) => {
              const isMonthly = (s + 1) % 4 === 0;
              return (
                <th key={s} className="px-2 py-2 text-center text-[10px] text-zinc-400 dark:text-zinc-500">
                  <div className="font-medium">W{s + 1}</div>
                  {isMonthly && <div className="text-[9px] text-violet-500">+M</div>}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {companies.map((company) => (
            <tr key={company.id} className="border-t border-zinc-100 dark:border-zinc-800">
              <td className="sticky left-0 z-10 bg-white px-3 py-2 dark:bg-zinc-950">
                <div className="flex items-center gap-1.5">
                  <div
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: company.color }}
                  />
                  <span className="truncate font-medium text-zinc-700 dark:text-zinc-300 max-w-[100px]">
                    {company.name}
                  </span>
                </div>
              </td>
              {steps.map((s) => {
                const weeklyResult = results.find((r) => r.company_id === company.id && r.step === s && r.loop === "weekly");
                const monthlyResult = results.find((r) => r.company_id === company.id && r.step === s && r.loop === "monthly");
                const isActive = activeCell?.companyId === company.id && activeCell?.step === s;
                const rec = weeklyResult?.recommendation;

                // Divergence: do all companies agree at this step?
                const allWeeklyRecs = companies.map((c) =>
                  results.find((r) => r.company_id === c.id && r.step === s && r.loop === "weekly")?.recommendation,
                ).filter(Boolean);
                const isDivergent = allWeeklyRecs.length > 1 && new Set(allWeeklyRecs).size > 1;

                return (
                  <td key={s} className="px-1 py-1">
                    <button
                      onClick={() => weeklyResult && onCellClick(company.id, s, "weekly")}
                      className={`w-full rounded-md px-2 py-1.5 text-center transition-all ${
                        rec ? REC_COLOR[rec] : "bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-600"
                      } ${isActive ? "ring-2 ring-sky-400" : ""} ${isDivergent ? "ring-1 ring-amber-400" : ""}`}
                    >
                      <div className="text-[11px] font-semibold capitalize">{rec ?? "—"}</div>
                      {weeklyResult?.confidence != null && (
                        <div className="text-[9px] opacity-70">{Math.round(weeklyResult.confidence * 100)}%</div>
                      )}
                      {monthlyResult && (
                        <div className="mt-0.5 text-[9px] text-violet-600 dark:text-violet-400">
                          M·{monthlyResult.recommendation ?? "—"}
                        </div>
                      )}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
          {/* Divergence row */}
          <tr className="border-t border-zinc-200 dark:border-zinc-700">
            <td className="sticky left-0 z-10 bg-white px-3 py-1 text-[10px] text-zinc-400 dark:bg-zinc-950 dark:text-zinc-500">
              Agreement
            </td>
            {steps.map((s) => {
              const recs = companies.map((c) =>
                results.find((r) => r.company_id === c.id && r.step === s && r.loop === "weekly")?.recommendation
              ).filter(Boolean);
              const unanimous = recs.length > 0 && new Set(recs).size === 1;
              return (
                <td key={s} className="px-1 py-1 text-center">
                  {recs.length === 0 ? (
                    <span className="text-[10px] text-zinc-300 dark:text-zinc-700">—</span>
                  ) : unanimous ? (
                    <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-medium text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400">
                      ✓
                    </span>
                  ) : (
                    <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-medium text-amber-700 dark:bg-amber-950/50 dark:text-amber-400">
                      split
                    </span>
                  )}
                </td>
              );
            })}
          </tr>
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/bench/SimTimeline.tsx
git commit -m "feat(sim): add SimTimeline component with divergence highlighting"
```

---

## Task 7: StepDrillDown component

**Files:**
- Create: `src/components/bench/StepDrillDown.tsx`

- [ ] **Step 1: Write StepDrillDown**

```typescript
// src/components/bench/StepDrillDown.tsx
"use client";

import { useState } from "react";
import type { CompanyConfig, StepResult } from "@/lib/bench-sim-types";

const REC_STYLE: Record<string, { label: string; cls: string }> = {
  approve: { label: "Approve", cls: "text-emerald-700 dark:text-emerald-400" },
  reject:  { label: "Reject",  cls: "text-red-700 dark:text-red-400" },
  defer:   { label: "Defer",   cls: "text-amber-700 dark:text-amber-400" },
};

export function StepDrillDown({ result, company, onClose }: {
  result: StepResult;
  company: CompanyConfig;
  onClose: () => void;
}) {
  const [activePersona, setActivePersona] = useState<string | null>(null);
  const personaKeys = Object.keys(result.personas).filter((k) => k !== "synthesizer");
  const recStyle = result.recommendation ? REC_STYLE[result.recommendation] : null;

  return (
    <div className="rounded-xl border border-sky-200 bg-sky-50/50 p-5 dark:border-sky-900 dark:bg-sky-950/20">
      {/* Header */}
      <div className="mb-4 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <div className="h-3 w-3 rounded-full" style={{ backgroundColor: company.color }} />
            <span className="text-[13px] font-semibold">{company.name}</span>
            <span className="text-[11px] text-zinc-400 dark:text-zinc-500">· Step {result.step + 1} · {result.loop}</span>
          </div>
          {recStyle && (
            <div className={`mt-1 text-[12px] font-semibold ${recStyle.cls}`}>
              {recStyle.label}
              {result.confidence != null && <span className="ml-1 font-normal opacity-70">({Math.round(result.confidence * 100)}%)</span>}
            </div>
          )}
          {result.change && (
            <p className="mt-1 text-[12px] text-zinc-600 dark:text-zinc-400">
              <span className="rounded bg-zinc-200 px-1 text-[10px] dark:bg-zinc-800">{result.change.kind.replace(/_/g, " ")}</span>
              {" "}{result.change.details}
            </p>
          )}
          {result.rationale && (
            <p className="mt-1 text-[11px] italic text-zinc-500 dark:text-zinc-400">&ldquo;{result.rationale}&rdquo;</p>
          )}
        </div>
        <button onClick={onClose} className="text-[11px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">
          Close ×
        </button>
      </div>

      {/* Extra fields */}
      {Object.entries(result.extra_fields).length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {Object.entries(result.extra_fields).map(([k, v]) => (
            <div key={k} className="rounded-md bg-white px-2.5 py-1.5 dark:bg-zinc-900">
              <div className="text-[9px] font-semibold uppercase tracking-wider text-zinc-400">{k.replace(/_/g, " ")}</div>
              <div className="text-[11px] text-zinc-600 dark:text-zinc-400 line-clamp-2">{v}</div>
            </div>
          ))}
        </div>
      )}

      {/* Persona tabs */}
      <div className="mb-2 flex flex-wrap gap-1">
        {personaKeys.map((k) => (
          <button
            key={k}
            onClick={() => setActivePersona(activePersona === k ? null : k)}
            className={`rounded-md px-2 py-1 text-[10px] font-medium capitalize transition-colors ${
              activePersona === k
                ? "bg-sky-200 text-sky-900 dark:bg-sky-900 dark:text-sky-200"
                : "bg-zinc-200 text-zinc-600 hover:bg-zinc-300 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700"
            }`}
          >
            {k.replace("_", " ")}
          </button>
        ))}
      </div>

      {/* Persona text */}
      {activePersona && result.personas[activePersona] && (
        <div className="rounded-lg bg-white p-3 dark:bg-zinc-900">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 capitalize">
            {activePersona.replace("_", " ")}
          </div>
          <p className="text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-400 whitespace-pre-wrap">
            {result.personas[activePersona]}
          </p>
        </div>
      )}

      {result.error && (
        <div className="mt-2 text-[11px] text-red-600 dark:text-red-400">Error: {result.error}</div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/bench/StepDrillDown.tsx
git commit -m "feat(sim): add StepDrillDown component for persona transcript view"
```

---

## Task 8: Company creation form (inline in sim page)

This is part of the simulation page — a form to define a new company without a separate route. Kept inline since it's small and page-specific.

**Files:**
- Create: `src/app/bench/sim/page.tsx` (initial skeleton with company form only)

- [ ] **Step 1: Write sim page skeleton with company creation form**

```typescript
// src/app/bench/sim/page.tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Play, ChevronRight, ChevronDown } from "lucide-react";
import { CompanyCard } from "@/components/bench/CompanyCard";
import { SimTimeline } from "@/components/bench/SimTimeline";
import { StepDrillDown } from "@/components/bench/StepDrillDown";
import { CONGRESS_SAMPLES } from "@/lib/bench-congress";
import type { CompanyConfig, SimSession, StepResult } from "@/lib/bench-sim-types";

const DEFAULT_ROSTER = {
  daily_model: "gemini-2.5-flash",
  weekly_persona_model: {},
  weekly_default: "gemini-2.5-flash",
  weekly_synth_model: "claude-sonnet-4-6",
  monthly_persona_model: {},
  monthly_default: "claude-sonnet-4-6",
  monthly_synth_model: "claude-sonnet-4-6",
  quarterly_model: "claude-sonnet-4-6",
};

const PRESET_COMPANIES: Omit<CompanyConfig, "id" | "created_at">[] = [
  {
    name: "Frontier Synth",
    tagline: "Expensive top-tier models everywhere. Does it pay off?",
    deliberation_style: "expansionist",
    model_roster: { ...DEFAULT_ROSTER, weekly_default: "claude-sonnet-4-6", weekly_synth_model: "claude-opus-4-7", monthly_default: "claude-sonnet-4-6", monthly_synth_model: "claude-opus-4-7" },
    persona_overrides: {},
    customer_profile: { segment: "top_tier_academia", communication_style: "formal" },
    color: "#8b5cf6",
  },
  {
    name: "Lean Fleet",
    tagline: "Fast cheap models for personas, frontier only for synth.",
    deliberation_style: "empiricist",
    model_roster: { ...DEFAULT_ROSTER, weekly_default: "gemini-2.5-flash", weekly_synth_model: "claude-sonnet-4-6", monthly_default: "gemini-2.5-flash", monthly_synth_model: "claude-sonnet-4-6" },
    persona_overrides: {},
    customer_profile: { segment: "mid_tier_startup", communication_style: "direct" },
    color: "#0ea5e9",
  },
  {
    name: "Cautious Council",
    tagline: "Conservative style, mixed models. Rarely approves.",
    deliberation_style: "conservative",
    model_roster: { ...DEFAULT_ROSTER, weekly_synth_model: "gemini-2.5-flash", monthly_synth_model: "claude-sonnet-4-6" },
    persona_overrides: {
      adversary: { system: "你的工作是 attack 任何提议的改动. 你极度悲观. 默认 defer.", question: "What is the single most likely failure mode? Give a concrete scenario where this causes net harm." },
    },
    customer_profile: { segment: "gov_lab", communication_style: "formal" },
    color: "#64748b",
  },
];

export default function SimPage() {
  const router = useRouter();
  const [gated, setGated] = useState<"checking" | "allowed" | "forbidden">("checking");
  const [companies, setCompanies] = useState<CompanyConfig[]>([]);
  const [sessions, setSessions] = useState<SimSession[]>([]);
  const [selectedCompanyIds, setSelectedCompanyIds] = useState<Set<string>>(new Set());
  const [activeSession, setActiveSession] = useState<{ session: SimSession; results: StepResult[] } | null>(null);
  const [activeCell, setActiveCell] = useState<{ companyId: string; step: number; loop: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNewSessionForm, setShowNewSessionForm] = useState(false);
  const [sessionName, setSessionName] = useState("");
  const [selectedScenario, setSelectedScenario] = useState(CONGRESS_SAMPLES[0].id);
  const [stepsPlanned, setStepsPlanned] = useState(4);
  const [crossVisibility, setCrossVisibility] = useState(true);

  useEffect(() => {
    fetch("/api/auth/me").then((r) => r.json()).then((d) => {
      if (d.authenticated && d.role === "admin") setGated("allowed");
      else { setGated("forbidden"); router.replace("/"); }
    }).catch(() => { setGated("forbidden"); router.replace("/"); });
  }, [router]);

  const refresh = useCallback(async () => {
    const r = await fetch("/api/bench/sim");
    if (!r.ok) return;
    const d = await r.json();
    setCompanies(d.companies ?? []);
    setSessions(d.sessions ?? []);
  }, []);

  useEffect(() => { if (gated === "allowed") refresh(); }, [gated, refresh]);

  const loadSession = useCallback(async (sessionId: string) => {
    const r = await fetch(`/api/bench/sim/${sessionId}`);
    if (!r.ok) return;
    const d = await r.json();
    setActiveSession({ session: d.session, results: d.results ?? [] });
    setActiveCell(null);
  }, []);

  const createPresetCompanies = async () => {
    setCreating(true);
    for (const preset of PRESET_COMPANIES) {
      await fetch("/api/bench/sim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create_company", company: preset }),
      });
    }
    await refresh();
    setCreating(false);
  };

  const createSession = async () => {
    if (selectedCompanyIds.size < 1) { setError("Select at least one company"); return; }
    if (!sessionName.trim()) { setError("Session name required"); return; }
    setError(null);
    const r = await fetch("/api/bench/sim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create_session",
        name: sessionName.trim(),
        scenario_id: selectedScenario,
        company_ids: [...selectedCompanyIds],
        steps_planned: stepsPlanned,
        cross_company_visibility: crossVisibility,
      }),
    });
    const d = await r.json();
    if (!r.ok) { setError(d.error); return; }
    await refresh();
    await loadSession(d.session.id);
    setShowNewSessionForm(false);
    setSessionName("");
  };

  const runNextStep = async () => {
    if (!activeSession) return;
    setRunning(true);
    setError(null);
    try {
      const r = await fetch("/api/bench/sim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "run_step", session_id: activeSession.session.id }),
      });
      if (!r.ok) { const d = await r.json(); setError(d.error); return; }
      await loadSession(activeSession.session.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  if (gated !== "allowed") {
    return <div className="flex justify-center p-24"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  }

  const activeCompanies = activeSession
    ? companies.filter((c) => (activeSession.session.company_ids as string[]).includes(c.id))
    : [];
  const activeCellResult = activeCell
    ? activeSession?.results.find((r) => r.company_id === activeCell.companyId && r.step === activeCell.step && r.loop === activeCell.loop) ?? null
    : null;
  const activeCellCompany = activeCell ? companies.find((c) => c.id === activeCell.companyId) ?? null : null;

  return (
    <>
      <header className="mb-6 border-b border-zinc-200 pb-4 dark:border-zinc-800">
        <div className="mb-1 text-xs text-zinc-500 dark:text-zinc-500">Bench · Simulation</div>
        <h1 className="text-lg font-medium">Company congress simulation</h1>
        <p className="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400">
          Multiple companies, each with its own four-loop congress architecture and model roster, run the same scenario. Watch trajectories diverge.
        </p>
      </header>

      {/* Companies section */}
      <section className="mb-6">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-[11px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
            Companies ({companies.length})
          </div>
          <button
            onClick={createPresetCompanies}
            disabled={creating}
            className="inline-flex items-center gap-1.5 rounded-md bg-zinc-100 px-3 py-1.5 text-[12px] text-zinc-700 hover:bg-zinc-200 disabled:opacity-60 dark:bg-zinc-800 dark:text-zinc-300"
          >
            {creating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
            Add presets
          </button>
        </div>
        {companies.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-[13px] text-zinc-400 dark:border-zinc-700 dark:text-zinc-500">
            No companies yet. Click "Add presets" to start with 3 example companies.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {companies.map((c) => (
              <CompanyCard
                key={c.id}
                company={c}
                selected={selectedCompanyIds.has(c.id)}
                onSelect={() => {
                  const next = new Set(selectedCompanyIds);
                  if (next.has(c.id)) next.delete(c.id); else next.add(c.id);
                  setSelectedCompanyIds(next);
                }}
              />
            ))}
          </div>
        )}
      </section>

      {/* Session controls */}
      <section className="mb-6 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-[11px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
            Simulation session
          </div>
          {sessions.length > 0 && (
            <select
              className="rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 text-[12px] text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
              onChange={(e) => e.target.value && loadSession(e.target.value)}
              defaultValue=""
            >
              <option value="">Load session…</option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>{s.name} ({s.steps_completed}/{s.steps_planned} steps)</option>
              ))}
            </select>
          )}
        </div>

        {!showNewSessionForm ? (
          <button
            onClick={() => setShowNewSessionForm(true)}
            className="inline-flex items-center gap-2 rounded-md border border-sky-300 bg-sky-50 px-4 py-2 text-[12px] text-sky-800 hover:bg-sky-100 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300"
          >
            <Plus className="h-3.5 w-3.5" /> New session
          </button>
        ) : (
          <div className="space-y-3">
            <input
              value={sessionName}
              onChange={(e) => setSessionName(e.target.value)}
              placeholder="Session name (e.g. 'May week 1 — frontier vs lean')"
              className="w-full rounded-md border border-zinc-200 px-3 py-2 text-[13px] dark:border-zinc-700 dark:bg-zinc-800"
            />
            <div className="flex flex-wrap gap-3 text-[12px]">
              <label className="flex items-center gap-1.5 text-zinc-600 dark:text-zinc-400">
                Scenario:
                <select
                  value={selectedScenario}
                  onChange={(e) => setSelectedScenario(e.target.value)}
                  className="rounded border border-zinc-200 px-2 py-0.5 dark:border-zinc-700 dark:bg-zinc-800"
                >
                  {CONGRESS_SAMPLES.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
                </select>
              </label>
              <label className="flex items-center gap-1.5 text-zinc-600 dark:text-zinc-400">
                Steps:
                <input
                  type="number" min={1} max={12}
                  value={stepsPlanned}
                  onChange={(e) => setStepsPlanned(Number(e.target.value))}
                  className="w-12 rounded border border-zinc-200 px-2 py-0.5 text-center dark:border-zinc-700 dark:bg-zinc-800"
                />
              </label>
              <label className="flex items-center gap-1.5 text-zinc-600 dark:text-zinc-400">
                <input type="checkbox" checked={crossVisibility} onChange={(e) => setCrossVisibility(e.target.checked)} />
                Companies see each other
              </label>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={createSession} className="rounded-md bg-sky-600 px-4 py-1.5 text-[12px] font-medium text-white hover:bg-sky-700">
                Create session
              </button>
              <button onClick={() => setShowNewSessionForm(false)} className="text-[12px] text-zinc-400 hover:text-zinc-600">
                Cancel
              </button>
            </div>
          </div>
        )}

        {error && <div className="mt-2 text-[12px] text-red-600 dark:text-red-400">{error}</div>}
      </section>

      {/* Active session */}
      {activeSession && (
        <section className="mb-6">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="text-base font-medium">{activeSession.session.name}</h2>
              <p className="text-[12px] text-zinc-500 dark:text-zinc-400">
                Step {activeSession.session.steps_completed} of {activeSession.session.steps_planned} ·{" "}
                {activeSession.session.cross_company_visibility ? "companies observe each other" : "isolated"}
              </p>
            </div>
            <button
              onClick={runNextStep}
              disabled={running || activeSession.session.status === "complete"}
              className="inline-flex items-center gap-2 rounded-md border border-sky-300 bg-sky-100 px-4 py-2 text-[13px] font-medium text-sky-800 hover:bg-sky-200 disabled:opacity-60 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200"
            >
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {running ? "Running…" : activeSession.session.status === "complete" ? "Complete" : "Run next step"}
            </button>
          </div>

          <SimTimeline
            companies={activeCompanies}
            results={activeSession.results}
            stepsCompleted={activeSession.session.steps_completed}
            onCellClick={(companyId, step, loop) => setActiveCell({ companyId, step, loop })}
            activeCell={activeCell}
          />

          {activeCellResult && activeCellCompany && (
            <div className="mt-4">
              <StepDrillDown
                result={activeCellResult}
                company={activeCellCompany}
                onClose={() => setActiveCell(null)}
              />
            </div>
          )}
        </section>
      )}

      {/* Customer fit summary — shows after 2+ steps */}
      {activeSession && activeSession.session.steps_completed >= 2 && (
        <CustomerFitSummary companies={activeCompanies} results={activeSession.results} />
      )}
    </>
  );
}

// ── Customer fit summary ───────────────────────────────────────────────────
// After enough steps, surfaces which company config approved most / least,
// linking back to the customer_profile for deployment recommendations.

function CustomerFitSummary({ companies, results }: { companies: CompanyConfig[]; results: StepResult[] }) {
  const weeklyResults = results.filter((r) => r.loop === "weekly");

  const stats = companies.map((c) => {
    const myResults = weeklyResults.filter((r) => r.company_id === c.id);
    const total = myResults.length;
    const approvals = myResults.filter((r) => r.recommendation === "approve").length;
    const avgConfidence = myResults.reduce((sum, r) => sum + (r.confidence ?? 0), 0) / (total || 1);
    return { company: c, approvals, total, approvalRate: total > 0 ? approvals / total : 0, avgConfidence };
  });

  return (
    <section className="rounded-xl border border-violet-200 bg-violet-50/50 p-5 dark:border-violet-900 dark:bg-violet-950/10">
      <div className="mb-3 text-[11px] font-medium uppercase tracking-wider text-violet-500 dark:text-violet-400">
        Customer fit signal
      </div>
      <p className="mb-3 text-[12px] text-zinc-500 dark:text-zinc-400">
        Which congress architecture approves most aggressively — and which customer segment does that fit?
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {stats.sort((a, b) => b.approvalRate - a.approvalRate).map(({ company, approvals, total, approvalRate, avgConfidence }) => (
          <div key={company.id} className="rounded-lg bg-white p-3 dark:bg-zinc-900">
            <div className="mb-1 flex items-center gap-1.5">
              <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: company.color }} />
              <span className="text-[12px] font-medium">{company.name}</span>
            </div>
            <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
              {approvals}/{total} approved · {Math.round(approvalRate * 100)}% rate · {Math.round(avgConfidence * 100)}% avg confidence
            </div>
            <div className="mt-1 text-[10px] text-violet-600 dark:text-violet-400">
              → Deploy for: {company.customer_profile?.segment?.replace(/_/g, " ") ?? "unknown"}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/bench/sim/page.tsx
git commit -m "feat(sim): add simulation dashboard page with company setup and timeline"
```

---

## Task 9: Wire into bench tabs

**Files:**
- Modify: `src/app/bench/page.tsx`

- [ ] **Step 1: Read the current bench page**

Read `src/app/bench/page.tsx` lines 1-50 to find the tab structure.

- [ ] **Step 2: Add Simulation tab**

In the tab list (where "Writer" and "Congress" tabs are defined), add a third tab:

```tsx
{ key: "sim", label: "Simulation" }
```

And in the tab content area, add:

```tsx
{activeTab === "sim" && (
  <iframe src="/bench/sim" className="w-full border-0" style={{ height: "calc(100vh - 120px)" }} title="Simulation" />
)}
```

Note: Use an iframe here so the simulation page runs as its own client component context without tangling with the bench page's writer/congress state. If the bench page is already a clean tab-switcher with no shared state issues, render `<SimPage />` directly instead — read the file first to decide.

- [ ] **Step 3: Commit**

```bash
git add src/app/bench/page.tsx
git commit -m "feat(sim): wire simulation tab into bench dashboard"
```

---

## Self-Review

### Spec coverage check

| Requirement | Task |
|---|---|
| N user-defined companies with names, models, deliberation style | Task 1 (types) + Task 5 (CompanyCard) + Task 8 (create_company API + preset form) |
| Model roster per persona and loop level | Task 1 (CompanyModelRoster) + Task 2 (resolveModel) |
| Persona overrides per company | Task 1 (PersonaOverride) + Task 2 (applyOverride) |
| Four loop levels (daily/weekly/monthly/quarterly) | Task 2 (runCompanyWeeklyStep + runCompanyMonthlyStep; daily/quarterly are stubs — JITR is real-world only, quarterly fires on breach detection) |
| Feedforward state (directives → next weekly prompt) | Task 2 (buildStateContext + advanceCompanyState) + Task 4 (state persistence) |
| Multiple time steps sequenced | Task 4 (run_step action advances steps_completed) + Task 8 (Run next step button) |
| Cross-company market visibility | Task 2 (MarketSignal) + Task 4 (priorSignals build + cross_company_visibility flag) |
| Customer segment fit layer | Task 1 (customer_profile) + Task 5 (CompanyCard display) + Task 8 (CustomerFitSummary) |
| Timeline UI (companies × steps × divergence) | Task 6 (SimTimeline with divergence row) |
| Drill-down into persona transcripts | Task 7 (StepDrillDown) |
| DB persistence | Task 3 (migration 038) |
| REST API | Task 4 |
| Wired into bench | Task 9 |

**Note on daily/quarterly loops:** Daily (JITR) and quarterly (postmortem) loops are not simulated — JITR requires rep interaction, postmortem requires a breach signal. They are represented in the type system and state (jitr_learnings, postmortem_context) but not run in simulation. Monthly loop runs every 4 weekly steps automatically.

### Placeholder scan
No TBD or TODO left. All code blocks are complete. Task 9 has a conditional note about iframe vs direct render — resolved by reading the file first (explicitly called out as step 1).

### Type consistency
- `CompanyConfig.id` is `string` throughout (uuid from DB). ✓
- `StepResult.change` is `{ kind: string; details: string } | null` — matches `change_spec` DB column (stored as jsonb, parsed back consistently). ✓
- `CompanyState` is stored as jsonb in `bench_company_states.state` — deserialized as-is. ✓
- `resolveModel` accepts `LoopLevel` and returns `string` — called with `"weekly"` and `"monthly"` literals only. ✓
