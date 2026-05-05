// GET /api/congress/timeline → museum-wall data.
// Per-company lane: lifecycle events, contract dots with hit/miss state,
// full conviction trajectory (every bet), pending proposals count.
// Plus: per-investor capital trajectory, weight-version flips, today's date.
//
// One denormalized payload, not five round-trips. The UI just renders.

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

export type DotKind = "funded" | "weekly" | "monthly" | "quarterly" | "conviction" | "cut" | "milestone";
export type DotOutcome = "hit" | "miss" | "pending" | "info";

export interface MinutesPosition {
  persona: string;
  message: string;
}
export interface MinutesAttack {
  attacks_persona: string;
  message: string;
  rebuttal?: { by_persona: string; message: string };
}
export interface MeetingMinutes {
  positions: MinutesPosition[];      // round 1
  attacks: MinutesAttack[];           // round 2
  synthesizer: string;                // final
  recommendation: string | null;
  confidence: number | null;
}

export interface TimelineDot {
  id: string;
  at: string;
  kind: DotKind;
  outcome: DotOutcome;
  label: string;
  // Inline number that shows next to the dot, e.g. "32/30" or "0.66".
  inline?: string;
  // Detail block shown when the user clicks the dot.
  story: {
    headline: string;
    fields: Array<{ label: string; value: string | number }>;
    body?: string;
    links?: Array<{ label: string; href: string }>;
  };
  // Full meeting minutes if this dot is a deliberation. Lazy-loaded by id.
  minutes?: MeetingMinutes;
}

export interface ConvictionPoint { at: string; value: number }

export interface TimelineLane {
  company_id: string;
  company_name: string;
  color: string;
  thesis: string | null;
  target_segment: string | null;
  active: boolean;
  funded_at: string | null;
  current_conviction: number | null;
  current_capital_staked: number;       // sum of stakes still in open contracts
  contracts_hit: number;
  contracts_miss: number;
  contracts_open: number;
  proposals_pending: number;
  conviction_trajectory: ConvictionPoint[];
  dots: TimelineDot[];
}

export interface InvestorTrack {
  id: string;
  name: string;
  style: string;
  color: string;
  current_balance: number;
  trajectory: Array<{ at: string; balance: number }>;
}

export interface WeightFlip {
  at: string;
  version: number;
  source: string;
  rationale: string;
}

export interface TimelinePayload {
  lanes: TimelineLane[];
  investors: InvestorTrack[];
  weight_flips: WeightFlip[];
  range: { start: string; end: string };
  generated_at: string;
}

const INVESTOR_COLORS: Record<string, string> = {
  Founder: "#0f172a",
  "Atlas Capital": "#a855f7",
  "Bramble Holdings": "#475569",
};

export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const [
    { data: companies },
    { data: investors },
  ] = await Promise.all([
    supabase
      .from("bench_companies")
      .select("id, name, color, thesis, target_segment, active, funded_at")
      .order("created_at", { ascending: true }),
    supabase
      .from("investor_agents")
      .select("id, name, style")
      .eq("active", true)
      .order("created_at", { ascending: true }),
  ]);

  const companyIds = (companies ?? []).map((c) => c.id as string);

  // Bulk pulls.
  const [
    { data: events },
    { data: contracts },
    { data: bets },
    { data: ledger },
    { data: proposals },
    { data: weights },
    { data: steps },
  ] = await Promise.all([
    companyIds.length === 0
      ? Promise.resolve({ data: [] })
      : supabase.from("company_lifecycle").select("*").in("company_id", companyIds).order("occurred_at", { ascending: true }),
    companyIds.length === 0
      ? Promise.resolve({ data: [] })
      : supabase.from("company_contracts").select("id, company_id, action_label, segment, prediction, postmortem, opened_at, closes_at, settled_at, target_score, running_score, capital_staked, state").in("company_id", companyIds).order("opened_at", { ascending: true }),
    companyIds.length === 0
      ? Promise.resolve({ data: [] })
      : supabase.from("investor_bets").select("id, company_id, investor_id, conviction, action, rationale, decided_at").in("company_id", companyIds).order("decided_at", { ascending: true }),
    supabase.from("investor_capital_ledger").select("investor_id, kind, balance_after, occurred_at").order("occurred_at", { ascending: true }),
    companyIds.length === 0
      ? Promise.resolve({ data: [] })
      : supabase.from("company_proposals").select("id, company_id, state, kind").in("company_id", companyIds),
    supabase.from("points_table_versions").select("id, version, source, effective_from, rationale").order("effective_from", { ascending: true }),
    companyIds.length === 0
      ? Promise.resolve({ data: [] })
      : supabase.from("bench_step_results").select("company_id, loop, personas, recommendation, confidence, extra_fields").in("company_id", companyIds),
  ]);

  // Index step results by contract_id (stored in extra_fields.contract_id).
  const stepByContract = new Map<string, Record<string, unknown>>();
  for (const s of (steps ?? []) as Array<Record<string, unknown>>) {
    const cid = (s.extra_fields as { contract_id?: string } | null)?.contract_id;
    if (cid) stepByContract.set(cid, s);
  }

  // Index by company. Use Record<string, unknown> to keep the supabase
  // typings loose without narrowing fields away.
  type Row = Record<string, unknown>;
  const eventsBy = groupBy((events ?? []) as Row[], (r) => r.company_id as string);
  const contractsBy = groupBy((contracts ?? []) as Row[], (r) => r.company_id as string);
  const betsBy = groupBy((bets ?? []) as Row[], (r) => r.company_id as string);
  const proposalsBy = groupBy((proposals ?? []) as Row[], (r) => r.company_id as string);

  // Range bounds: earliest funded_at → today + 5 days.
  let minAt = "9999";
  let maxAt = "0000";
  const track = (iso: string | null | undefined) => {
    if (!iso) return;
    if (iso < minAt) minAt = iso;
    if (iso > maxAt) maxAt = iso;
  };

  const lanes: TimelineLane[] = (companies ?? []).map((c) => {
    const cid = c.id as string;
    const myEvents = (eventsBy.get(cid) ?? []) as unknown as Array<{ id: string; event: string; label: string; occurred_at: string; meta: Record<string, unknown> }>;
    const myContracts = (contractsBy.get(cid) ?? []) as unknown as Array<{ id: string; action_label: string; segment: string | null; prediction: string; postmortem: string | null; opened_at: string; closes_at: string; settled_at: string | null; target_score: number; running_score: number; capital_staked: number; state: string }>;
    const myBets = (betsBy.get(cid) ?? []) as unknown as Array<{ id: string; conviction: number; action: string; rationale: string; decided_at: string; investor_id: string }>;
    const myProposals = (proposalsBy.get(cid) ?? []) as unknown as Array<{ state: string }>;

    const dots: TimelineDot[] = [];

    // Funding dot.
    const fundedEvent = myEvents.find((e) => e.event === "funded");
    if (fundedEvent) {
      const meta = fundedEvent.meta ?? {};
      dots.push({
        id: `${cid}:funded`,
        at: fundedEvent.occurred_at,
        kind: "funded",
        outcome: "info",
        label: `Funded`,
        inline: meta.conviction != null ? `c ${Number(meta.conviction).toFixed(2)}` : undefined,
        story: {
          headline: `${c.name} funded`,
          fields: [
            { label: "Investor", value: String(meta.investor_id ?? "—") },
            { label: "Initial conviction", value: meta.conviction != null ? Number(meta.conviction).toFixed(2) : "—" },
            { label: "Thesis", value: String(meta.thesis ?? c.thesis ?? "—") },
          ],
          body: String(meta.thesis ?? c.thesis ?? ""),
        },
      });
      track(fundedEvent.occurred_at);
    }

    // Contract dots — these are the meat. Each weekly meeting = one contract.
    for (const ct of myContracts) {
      const isMonthly = ct.action_label.toLowerCase().includes("monthly") || (ct.action_label.match(/week\s*(\d+)/i)?.[1] === "5");
      const kind: DotKind = isMonthly ? "monthly" : "weekly";
      const outcome: DotOutcome = ct.state === "hit" ? "hit" : ct.state === "missed" ? "miss" : ct.state === "open" ? "pending" : "info";
      const inline = `${Math.round(Number(ct.running_score))}/${Math.round(Number(ct.target_score))}`;

      // Pull deliberation minutes from the matching bench_step_results row.
      const stepRow = stepByContract.get(ct.id);
      let minutes: MeetingMinutes | undefined;
      if (stepRow) {
        const personas = (stepRow.personas ?? {}) as Record<string, string>;
        const extra = (stepRow.extra_fields ?? {}) as { attacks?: Array<{ attacks_persona: string; message: string; rebuttal?: { by_persona: string; message: string } }> };
        const positionOrder = ["data_analyst", "copywriter", "academic_proxy", "sales_director", "psychologist"];
        const positions: MinutesPosition[] = positionOrder
          .filter((k) => typeof personas[k] === "string" && personas[k].length > 0)
          .map((k) => ({ persona: k, message: personas[k] }));
        // Adversary text: prefer the entry inside attacks[]; fall back to personas.adversary.
        const attacks: MinutesAttack[] = extra.attacks ?? (
          personas.adversary
            ? [{ attacks_persona: "data_analyst", message: personas.adversary }]
            : []
        );
        minutes = {
          positions,
          attacks,
          synthesizer: personas.synthesizer ?? "",
          recommendation: (stepRow.recommendation as string) ?? null,
          confidence: (stepRow.confidence as number) ?? null,
        };
      }

      dots.push({
        id: `${cid}:contract:${ct.id}`,
        at: ct.settled_at ?? ct.opened_at,
        kind,
        outcome,
        label: ct.action_label,
        inline,
        story: {
          headline: ct.action_label,
          fields: [
            { label: "Segment", value: ct.segment ?? "—" },
            { label: "Target", value: `${Math.round(Number(ct.target_score))} pts` },
            { label: "Landed", value: `${Math.round(Number(ct.running_score))} pts` },
            { label: "Capital staked", value: Number(ct.capital_staked).toFixed(0) },
            { label: "Outcome", value: ct.state.toUpperCase() },
            { label: "Window", value: `${new Date(ct.opened_at).toLocaleDateString()} → ${new Date(ct.closes_at).toLocaleDateString()}` },
          ],
          body: ct.postmortem || ct.prediction || "",
        },
        minutes,
      });
      track(ct.opened_at);
      track(ct.settled_at ?? ct.closes_at);
    }

    // Conviction-change events — small annotations.
    for (const e of myEvents) {
      if (e.event !== "conviction_change") continue;
      const meta = e.meta ?? {};
      const prior = meta.prior != null ? Number(meta.prior) : null;
      const next = meta.next != null ? Number(meta.next) : null;
      dots.push({
        id: `${cid}:conv:${e.id}`,
        at: e.occurred_at,
        kind: "conviction",
        outcome: "info",
        label: e.label,
        inline: next != null ? `→ ${next.toFixed(2)}` : undefined,
        story: {
          headline: "Investor changed conviction",
          fields: [
            { label: "Prior", value: prior != null ? prior.toFixed(2) : "—" },
            { label: "Next", value: next != null ? next.toFixed(2) : "—" },
            { label: "Action", value: String(meta.action ?? "—") },
          ],
        },
      });
      track(e.occurred_at);
    }

    // Cut event if any.
    for (const e of myEvents) {
      if (e.event !== "cut") continue;
      dots.push({
        id: `${cid}:cut:${e.id}`,
        at: e.occurred_at,
        kind: "cut",
        outcome: "info",
        label: e.label,
        story: {
          headline: "Company cut",
          fields: [{ label: "Reason", value: String((e.meta as { rationale?: string })?.rationale ?? "—") }],
        },
      });
      track(e.occurred_at);
    }

    dots.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

    // Conviction trajectory: every bet over time.
    const conviction_trajectory: ConvictionPoint[] = (myBets ?? [])
      .map((b) => ({ at: b.decided_at, value: Number(b.conviction) }))
      .sort((a, b) => (a.at < b.at ? -1 : 1));

    const currentConv = conviction_trajectory.length > 0 ? conviction_trajectory[conviction_trajectory.length - 1].value : null;

    // Per-company contract counts + open-stake total.
    let hit = 0, miss = 0, open = 0, openStake = 0;
    for (const ct of myContracts) {
      if (ct.state === "hit") hit++;
      else if (ct.state === "missed") miss++;
      else if (ct.state === "open") { open++; openStake += Number(ct.capital_staked); }
    }
    let proposals_pending = 0;
    for (const p of myProposals) {
      if (["pending", "editor_review", "admin_review"].includes(p.state)) proposals_pending++;
    }

    return {
      company_id: cid,
      company_name: c.name as string,
      color: (c.color as string) ?? "#6366f1",
      thesis: (c.thesis as string | null) ?? null,
      target_segment: (c.target_segment as string | null) ?? null,
      active: (c.active as boolean) ?? true,
      funded_at: (c.funded_at as string | null) ?? null,
      current_conviction: currentConv,
      current_capital_staked: openStake,
      contracts_hit: hit,
      contracts_miss: miss,
      contracts_open: open,
      proposals_pending,
      conviction_trajectory,
      dots,
    };
  });

  // Investor tracks: capital balance over time.
  const investorTracks: InvestorTrack[] = (investors ?? []).map((inv) => {
    const my = (ledger ?? []).filter((r) => r.investor_id === inv.id);
    const trajectory = my.map((r) => ({ at: r.occurred_at as string, balance: Number(r.balance_after) }));
    const currentBal = trajectory.length > 0 ? trajectory[trajectory.length - 1].balance : 0;
    for (const t of trajectory) track(t.at);
    return {
      id: inv.id as string,
      name: inv.name as string,
      style: inv.style as string,
      color: INVESTOR_COLORS[inv.name as string] ?? "#475569",
      current_balance: currentBal,
      trajectory,
    };
  });

  // Weight-version flips (only those that have already happened, by version > 1).
  const weight_flips: WeightFlip[] = (weights ?? [])
    .filter((w) => Number(w.version) > 1)
    .map((w) => ({
      at: w.effective_from as string,
      version: Number(w.version),
      source: String(w.source),
      rationale: String(w.rationale ?? ""),
    }));
  for (const f of weight_flips) track(f.at);

  // Bound the range. Always include today.
  const todayIso = new Date().toISOString();
  track(todayIso);
  if (minAt === "9999") minAt = new Date(Date.now() - 30 * 86_400_000).toISOString();
  if (maxAt === "0000") maxAt = todayIso;
  // Add one week of trailing space so today doesn't sit at the right edge.
  const trailing = new Date(new Date(maxAt).getTime() + 5 * 86_400_000).toISOString();
  if (trailing > maxAt) maxAt = trailing;

  const payload: TimelinePayload = {
    lanes,
    investors: investorTracks,
    weight_flips,
    range: { start: minAt, end: maxAt },
    generated_at: new Date().toISOString(),
  };
  return NextResponse.json(payload);
}

function groupBy<T, K>(rows: T[], key: (r: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = m.get(k) ?? [];
    list.push(r);
    m.set(k, list);
  }
  return m;
}
