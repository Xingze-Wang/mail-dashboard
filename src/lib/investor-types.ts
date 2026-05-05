// Shared types for the investor / portfolio framing on top of the
// bench-companies infra. The "investor" is an agent (stub today, LLM-
// backed later) that funds congresses, holds convictions, and revises
// them as evidence accumulates.

export type BetAction = "fund" | "double_down" | "hold" | "trim" | "cut";

export type LifecycleEvent =
  | "funded"
  | "thesis_revised"
  | "first_proposal"
  | "first_ship"
  | "first_conversion"
  | "conviction_change"
  | "cut"
  | "milestone";

export interface InvestorAgent {
  id: string;
  name: string;
  style: string;
  system_prompt: string;
  memory: Array<{ at: string; note: string }>;
  default_conviction: number;
  active: boolean;
  created_at: string;
}

export interface InvestorBet {
  id: string;
  investor_id: string;
  company_id: string;
  conviction: number;
  action: BetAction;
  rationale: string;
  metric_snapshot: Record<string, unknown>;
  decided_at: string;
}

export interface CompanyLifecycle {
  id: string;
  company_id: string;
  event: LifecycleEvent;
  label: string;
  meta: Record<string, unknown>;
  occurred_at: string;
}

export interface CompanyWithPortfolio {
  id: string;
  name: string;
  tagline: string;
  thesis: string | null;
  target_segment: string | null;
  funded_by: string | null;
  funded_at: string | null;
  active: boolean;
  color: string;
  // Latest bet snapshot, if any.
  latest_bet?: InvestorBet | null;
  // Recent lifecycle events, descending.
  recent_events?: CompanyLifecycle[];
}
