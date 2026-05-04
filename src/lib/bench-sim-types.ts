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
