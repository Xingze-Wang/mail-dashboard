// Congress UI types. Extends what's in the DB schema (which uses
// looser shapes — `deliberation: {personas: {key: text}}`) into a
// richer view-layer shape with Round 1 positions and Round 2 attacks.
// The adapter at src/lib/congress/adapter.ts maps DB → these types.

export type Cadence = "daily" | "weekly" | "monthly" | "quarterly";

export type ProposalCategory =
  | "email_content"
  | "subject_line"
  | "routing"
  | "landing_page"
  | "targeting"
  | "template_phrase_swap"
  | "copy_edit"
  | "routing_tweak"
  | "subject_line_test";

export type ProposalScope = "org" | "per_rep" | "per_segment";

export type DecisionStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "deferred"
  | "measuring"
  | "reverted";

export type PersonaRole =
  | "data_analyst"
  | "copywriter"
  | "academic_proxy"
  | "sales_director"
  | "psychologist"
  | "adversary"
  | "synthesizer";

export type PersonaPosition = {
  persona: PersonaRole;
  message: string;
  proposed?: string;
};

export type AdversaryAttack = {
  attacks_persona: PersonaRole;
  message: string;
  rebuttal?: { by_persona: PersonaRole; message: string };
};

export type ProposalStats = {
  sample_size: number;
  baseline: string;
  projected_delta: string;
  weeks_to_significance: number;
  rollback: string;
};

export type Proposal = {
  id: string;
  run_id: string;
  week: number;
  category: ProposalCategory;
  scope: ProposalScope;
  title: string;
  positions: PersonaPosition[];
  attacks: AdversaryAttack[];
  synthesizer_ranking: string;
  rank: number;
  vote_summary: string;
  stats: ProposalStats;
  decision: DecisionStatus;
  decided_at?: string;
  outcome_lift?: string;
  outcome_status?: string;
};

export type WeeklyMetric = {
  week: number;
  /** Legacy alias of wechat_rate. Distinct brief_lookups / distinct emails sent, in %. Kept for back-compat. */
  conversion_rate: number;
  /** % of distinct recipients in the week MP marked as registered (or stronger). */
  registered_rate: number;
  /** % of distinct recipients in the week with a submittedApplication signal. */
  submitted_rate: number;
  /** % of distinct recipients in the week we marked added_wechat=true. */
  wechat_rate: number;
};
export type DecisionMarker = {
  week: number;
  proposal_id: string;
  title: string;
  status: DecisionStatus;
  outcome?: string;
};

export const PERSONA_META: Record<
  PersonaRole,
  { initials: string; label: string; role: string }
> = {
  data_analyst: { initials: "DA", label: "Data analyst", role: "enforces statistical reality" },
  copywriter: { initials: "CW", label: "Copywriter", role: "tone & top-of-funnel" },
  academic_proxy: { initials: "AP", label: "Academic proxy", role: "advocates for the researcher" },
  sales_director: { initials: "SD", label: "Sales director", role: "bottom of funnel" },
  psychologist: { initials: "PS", label: "Psychologist", role: "watches emotional capital + rep burnout" },
  adversary: { initials: "AD", label: "Adversary", role: "attacks claims" },
  synthesizer: { initials: "SY", label: "Synthesizer", role: "final ranking" },
};

export const CATEGORY_LABEL: Record<string, string> = {
  email_content: "Email content",
  subject_line: "Subject line",
  subject_line_test: "Subject line A/B",
  routing: "Routing",
  routing_tweak: "Routing tweak",
  landing_page: "Landing page",
  targeting: "Targeting",
  template_phrase_swap: "Template phrase swap",
  copy_edit: "Copy edit",
};

export const SCOPE_LABEL: Record<ProposalScope, string> = {
  org: "org-wide",
  per_rep: "per-rep",
  per_segment: "per-segment",
};
