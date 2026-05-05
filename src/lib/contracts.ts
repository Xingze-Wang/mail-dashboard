// Contract lifecycle helpers — open, attribute event points, settle.
// Anything that *creates*, *updates*, or *grades* a contract calls into
// here so the rules of the points economy stay in one file.

import { supabase } from "@/lib/db";

export type ContractState = "open" | "hit" | "missed" | "cancelled";

export interface PointsWeight {
  event_kind: string;
  weight: number;
  is_terminal: boolean;
}

export interface PointsVersion {
  id: string;
  version: number;
  source: string;
  effective_from: string;
  effective_to: string | null;
  weights: PointsWeight[];
}

export interface OpenContractInput {
  company_id: string;
  rep_id?: number | null;
  segment?: string | null;
  action_label: string;
  action_spec?: Record<string, unknown>;
  target_score: number;
  capital_staked: number;
  prediction?: string;
  duration_days?: number; // default 7
  investor_id?: string;   // who is staking the capital
}

export async function getCurrentPointsVersion(): Promise<PointsVersion | null> {
  const { data: ver } = await supabase
    .from("points_table_versions")
    .select("id, version, source, effective_from, effective_to")
    .is("effective_to", null)
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!ver) return null;
  const { data: weights } = await supabase
    .from("points_table_weights")
    .select("event_kind, weight, is_terminal")
    .eq("version_id", ver.id);
  return {
    id: ver.id as string,
    version: ver.version as number,
    source: ver.source as string,
    effective_from: ver.effective_from as string,
    effective_to: (ver.effective_to as string | null) ?? null,
    weights: ((weights ?? []) as PointsWeight[]).map((w) => ({
      event_kind: w.event_kind as string,
      weight: Number(w.weight),
      is_terminal: w.is_terminal,
    })),
  };
}

export async function getPointsVersion(versionId: string): Promise<PointsVersion | null> {
  const { data: ver } = await supabase
    .from("points_table_versions")
    .select("id, version, source, effective_from, effective_to")
    .eq("id", versionId)
    .maybeSingle();
  if (!ver) return null;
  const { data: weights } = await supabase
    .from("points_table_weights")
    .select("event_kind, weight, is_terminal")
    .eq("version_id", ver.id);
  return {
    id: ver.id as string,
    version: ver.version as number,
    source: ver.source as string,
    effective_from: ver.effective_from as string,
    effective_to: (ver.effective_to as string | null) ?? null,
    weights: ((weights ?? []) as PointsWeight[]).map((w) => ({
      event_kind: w.event_kind as string,
      weight: Number(w.weight),
      is_terminal: w.is_terminal,
    })),
  };
}

/**
 * Open a contract. Stakes capital from the investor's ledger atomically:
 * 1. read latest balance
 * 2. write a stake row that drives balance down
 * 3. create the contract row
 * Returns the contract_id.
 */
export async function openContract(input: OpenContractInput): Promise<{ contract_id: string } | { error: string }> {
  const ver = await getCurrentPointsVersion();
  if (!ver) return { error: "no active points table version" };

  const closesAt = new Date(Date.now() + (input.duration_days ?? 7) * 86_400_000).toISOString();

  // If an investor is supplied, debit their balance.
  if (input.investor_id) {
    const { data: latest } = await supabase
      .from("investor_capital_ledger")
      .select("balance_after")
      .eq("investor_id", input.investor_id)
      .order("occurred_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const balance = Number(latest?.balance_after ?? 0);
    if (balance < input.capital_staked) {
      return { error: `insufficient capital: balance=${balance}, requested=${input.capital_staked}` };
    }
  }

  const { data: contract, error: contractErr } = await supabase
    .from("company_contracts")
    .insert({
      company_id: input.company_id,
      points_version_id: ver.id,
      rep_id: input.rep_id ?? null,
      segment: input.segment ?? null,
      action_label: input.action_label,
      action_spec: input.action_spec ?? {},
      target_score: input.target_score,
      capital_staked: input.capital_staked,
      state: "open",
      prediction: input.prediction ?? "",
      closes_at: closesAt,
    })
    .select("id")
    .single();
  if (contractErr || !contract) return { error: contractErr?.message ?? "insert failed" };

  if (input.investor_id) {
    const { data: latest } = await supabase
      .from("investor_capital_ledger")
      .select("balance_after")
      .eq("investor_id", input.investor_id)
      .order("occurred_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const balance = Number(latest?.balance_after ?? 0);
    await supabase.from("investor_capital_ledger").insert({
      investor_id: input.investor_id,
      kind: "stake",
      delta: -input.capital_staked,
      balance_after: balance - input.capital_staked,
      contract_id: contract.id,
      company_id: input.company_id,
      note: `Stake on contract ${input.action_label.slice(0, 60)}`,
    });
  }

  await supabase.from("company_lifecycle").insert({
    company_id: input.company_id,
    event: "milestone",
    label: `Contract opened: ${input.action_label}`,
    meta: { contract_id: contract.id, target_score: input.target_score, capital_staked: input.capital_staked },
  });

  return { contract_id: contract.id };
}

/**
 * Find the open contract that should claim a given event, if any.
 * Matching priority: rep + segment > rep > segment > company-wide-active.
 * Returns at most one contract — the most-specific match wins.
 */
export async function findActiveContract(opts: { rep_id?: number | null; segment?: string | null; at: string }): Promise<{ id: string; company_id: string; points_version_id: string } | null> {
  const { rep_id, segment, at } = opts;
  // Specificity tiers. We try the most specific first.
  const tiers: Array<Record<string, unknown>> = [];
  if (rep_id != null && segment) tiers.push({ rep_id, segment });
  if (rep_id != null) tiers.push({ rep_id });
  if (segment) tiers.push({ segment });
  // Company-wide fallback: any open contract with no rep + no segment.
  tiers.push({ rep_id: null, segment: null });

  for (const filter of tiers) {
    let q = supabase
      .from("company_contracts")
      .select("id, company_id, points_version_id, opened_at, closes_at")
      .eq("state", "open")
      .lte("opened_at", at)
      .gte("closes_at", at);
    for (const [k, v] of Object.entries(filter)) {
      if (v === null) q = q.is(k, null);
      else q = q.eq(k, v as string | number);
    }
    const { data } = await q.order("opened_at", { ascending: false }).limit(1);
    if (data && data.length > 0) {
      const row = data[0];
      return { id: row.id as string, company_id: row.company_id as string, points_version_id: row.points_version_id as string };
    }
  }
  return null;
}

/**
 * Attribute an event to the contract that owns it (if any), under the
 * contract's frozen points-table version. Bumps running_score and
 * settles if target is hit.
 */
export async function attributeEventToContract(opts: {
  rep_id?: number | null;
  segment?: string | null;
  event_kind: string;
  occurred_at: string;
  source_kind: string;
  source_id?: string | null;
}): Promise<{ contract_id: string; points_awarded: number; new_running_score: number } | null> {
  const contract = await findActiveContract({ rep_id: opts.rep_id, segment: opts.segment, at: opts.occurred_at });
  if (!contract) return null;

  const ver = await getPointsVersion(contract.points_version_id);
  if (!ver) return null;
  const weight = ver.weights.find((w) => w.event_kind === opts.event_kind);
  if (!weight || weight.weight === 0) return null;

  const points = Number(weight.weight);
  await supabase.from("contract_event_attributions").insert({
    contract_id: contract.id,
    source_kind: opts.source_kind,
    source_id: opts.source_id ?? null,
    event_kind: opts.event_kind,
    points_awarded: points,
    occurred_at: opts.occurred_at,
  });

  // Bump the running_score atomically. We re-read after write so the
  // returned value matches the row.
  const { data: cur } = await supabase
    .from("company_contracts")
    .select("running_score, target_score, state")
    .eq("id", contract.id)
    .maybeSingle();
  if (!cur) return null;
  const newScore = Number(cur.running_score) + points;
  await supabase.from("company_contracts").update({ running_score: newScore }).eq("id", contract.id);

  if (cur.state === "open" && newScore >= Number(cur.target_score)) {
    await settleContract(contract.id, "hit", `Hit target ${cur.target_score} via ${opts.event_kind} (+${points})`);
  }

  return { contract_id: contract.id, points_awarded: points, new_running_score: newScore };
}

export async function settleContract(contractId: string, state: "hit" | "missed" | "cancelled", postmortem: string): Promise<void> {
  const now = new Date().toISOString();
  const { data: contract } = await supabase
    .from("company_contracts")
    .select("id, company_id, capital_staked, action_label, target_score, running_score, prediction, opened_at")
    .eq("id", contractId)
    .maybeSingle();
  if (!contract) return;

  await supabase.from("company_contracts").update({
    state,
    settled_at: now,
    postmortem,
  }).eq("id", contractId);

  // Write episodic memory — the company's own résumé. Read by the
  // company on its next deliberation; read by the investor on next tick.
  await supabase.from("company_episodic_memory").insert({
    company_id: contract.company_id,
    contract_id: contractId,
    summary: `${state.toUpperCase()}: "${contract.action_label}" — landed ${contract.running_score}/${contract.target_score} pts. ${postmortem}`,
    details: {
      action_label: contract.action_label,
      prediction: contract.prediction,
      target_score: Number(contract.target_score),
      points_landed: Number(contract.running_score),
      capital_staked: Number(contract.capital_staked),
      state,
      surprise: state === "hit" ? Number(contract.running_score) > Number(contract.target_score) * 1.5 : Number(contract.running_score) < Number(contract.target_score) * 0.3,
    },
    occurred_at: now,
  });

  // Lifecycle event for the timeline.
  await supabase.from("company_lifecycle").insert({
    company_id: contract.company_id,
    event: state === "hit" ? "first_ship" : "milestone",
    label: state === "hit" ? `Contract HIT` : state === "missed" ? `Contract MISSED` : `Contract cancelled`,
    meta: { contract_id: contractId, state, postmortem },
    occurred_at: now,
  });

  // Capital settlement: refund stake on hit (with 1.5x bonus), forfeit on miss.
  // Cancellation refunds 100% with no bonus.
  const { data: stakeRow } = await supabase
    .from("investor_capital_ledger")
    .select("investor_id, delta, balance_after")
    .eq("contract_id", contractId)
    .eq("kind", "stake")
    .maybeSingle();
  if (stakeRow) {
    const investorId = stakeRow.investor_id as string;
    const stakeAmt = Math.abs(Number(stakeRow.delta));
    let refund = 0;
    let kind: "refund" | "forfeit" = "refund";
    if (state === "hit") refund = stakeAmt * 1.5;
    else if (state === "cancelled") refund = stakeAmt;
    else { refund = 0; kind = "forfeit"; }

    const { data: latestRow } = await supabase
      .from("investor_capital_ledger")
      .select("balance_after")
      .eq("investor_id", investorId)
      .order("occurred_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const balance = Number(latestRow?.balance_after ?? 0);
    await supabase.from("investor_capital_ledger").insert({
      investor_id: investorId,
      kind,
      delta: refund,
      balance_after: balance + refund,
      contract_id: contractId,
      company_id: contract.company_id,
      note: state === "hit" ? `Refund + 50% bonus on hit` : state === "cancelled" ? `Refund on cancel` : `Forfeit on miss`,
    });
  }
}

/**
 * Sweep open contracts whose closes_at has passed and settle them as
 * "hit" if running_score >= target_score, else "missed".
 */
export async function sweepClosedContracts(): Promise<{ settled: number }> {
  const { data: due } = await supabase
    .from("company_contracts")
    .select("id, target_score, running_score")
    .eq("state", "open")
    .lt("closes_at", new Date().toISOString());
  let settled = 0;
  for (const c of due ?? []) {
    const hit = Number(c.running_score) >= Number(c.target_score);
    await settleContract(c.id as string, hit ? "hit" : "missed", `Auto-settled at expiry: ${c.running_score}/${c.target_score}`);
    settled++;
  }
  return { settled };
}
