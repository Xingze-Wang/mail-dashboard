// Adapter: DB row (tactical_proposals) → drop-in view-layer Proposal.
//
// Our DB stores deliberation as { personas: { key: text, ... } } — flat
// per-persona text. The drop-in UI wants Round 1 positions[] +
// Round 2 attacks[] separately. We don't currently capture distinct
// rounds in the DB (the LLM panelists run sequentially with running
// context but don't produce separate round-1/round-2 outputs). So:
//   - All personas other than adversary + synthesizer → positions[]
//   - Adversary → attacks[] (we don't have explicit attack-targets +
//     rebuttals, so we synthesize one attack with no rebuttal — Round 2
//     UI stays useful even with simpler data)
//   - Synthesizer text → synthesizer_ranking
//
// When/if the LLM orchestration starts producing structured rounds,
// drop the synthesis here.

import type {
  Proposal, PersonaPosition, AdversaryAttack, ProposalCategory, ProposalScope,
  DecisionStatus, PersonaRole,
} from "./types";

interface DbProposal {
  id: string;
  proposed_at: string;
  title: string;
  ship_decision: string;
  shipped_at: string | null;
  decided_at: string | null;
  weeks_to_evaluate: number;
  expected_lift: { metric?: string; delta_pp?: number; rationale?: string } | null;
  actual_lift: { sent?: number; open_rate?: number; click_rate?: number } | null;
  grade: string | null;
  change_spec: { kind?: string; details?: Record<string, unknown> } | null;
  deliberation: {
    personas?: Record<string, string>;
    evidence_pack_excerpt?: string;
  } | null;
}

const KNOWN_PERSONAS: PersonaRole[] = [
  "data_analyst", "copywriter", "academic_proxy",
  "sales_director", "psychologist",
];

function mapDecision(d: string, grade: string | null): DecisionStatus {
  if (grade === "miss") return "reverted"; // soft; we don't have an explicit reverted state in tactical_proposals yet
  if (d === "approved" && grade) return "measuring"; // graded => evaluation done; surfaces as approved still in our DB
  if (d === "approved") return "measuring";
  if (d === "rejected") return "rejected";
  if (d === "pending") return "pending";
  if (d === "superseded") return "deferred";
  return "pending";
}

function deriveCategory(kind: string | undefined): ProposalCategory {
  if (!kind) return "email_content";
  if (kind === "subject_line_test") return "subject_line";
  if (kind === "routing_tweak") return "routing";
  if (kind === "template_phrase_swap" || kind === "copy_edit") return "email_content";
  return (kind as ProposalCategory) ?? "email_content";
}

function isoToWeek(iso: string): number {
  // ISO week of year — used to align with the chart's W1..W18 axis.
  const d = new Date(iso);
  const onejan = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - onejan.getTime()) / 86400000 + onejan.getDay() + 1) / 7);
}

export function dbToProposal(db: DbProposal): Proposal {
  const personasMap = db.deliberation?.personas ?? {};
  const positions: PersonaPosition[] = [];
  for (const key of KNOWN_PERSONAS) {
    if (personasMap[key]) positions.push({ persona: key, message: personasMap[key] });
  }

  const attacks: AdversaryAttack[] = [];
  if (personasMap.adversary) {
    // The adversary text doesn't tag who it's attacking; default to data_analyst
    // (the panelist who proposes the most concrete claim by convention). When
    // we add a structured-attack output to the synthesizer, replace this.
    attacks.push({
      attacks_persona: "data_analyst",
      message: personasMap.adversary,
    });
  }

  const synthRaw = personasMap.synthesizer ?? "";
  // Strip the JSON envelope from synthesizer to surface a human-readable ranking
  let synthesizer_ranking = synthRaw;
  try {
    const cleaned = synthRaw.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
    const parsed = JSON.parse(cleaned);
    // Use the rationale from expected_lift if available, else title
    synthesizer_ranking = parsed.rationale ?? parsed.title ?? synthRaw;
  } catch { /* keep raw */ }

  const expected = db.expected_lift ?? {};
  const actual = db.actual_lift ?? {};

  return {
    id: db.id,
    run_id: `run_${isoToWeek(db.proposed_at)}`,
    week: isoToWeek(db.proposed_at),
    category: deriveCategory(db.change_spec?.kind),
    scope: "org",                                // we don't track scope yet — default
    title: db.title,
    positions,
    attacks,
    synthesizer_ranking,
    rank: 1,                                     // we surface 1 proposal at a time
    vote_summary: positions.length > 0
      ? `${positions.length} personas weighed in${attacks.length > 0 ? ` · ${attacks.length} attack${attacks.length === 1 ? "" : "s"}` : ""}`
      : "no panel data",
    stats: {
      sample_size: actual.sent ?? 0,
      baseline: actual.open_rate != null ? `${(actual.open_rate * 100).toFixed(1)}% open` : "—",
      projected_delta: expected.delta_pp != null ? `+${expected.delta_pp}pp ${expected.metric ?? ""}` : "—",
      weeks_to_significance: db.weeks_to_evaluate ?? 4,
      rollback: "migration revert + auto stop-loss",
    },
    decision: mapDecision(db.ship_decision, db.grade),
    decided_at: db.decided_at ?? undefined,
    outcome_lift: actual.click_rate != null ? `${(actual.click_rate * 100).toFixed(2)}% click` : undefined,
    outcome_status: db.grade ?? undefined,
  };
}
