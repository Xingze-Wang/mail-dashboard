// POST /api/investor/tick
// body: { investor_id: uuid }
// Reviews every active company funded by this investor, computes a fresh
// metric snapshot scoped to the company's target_segment, and writes a
// new investor_bets row with an updated conviction + action.
//
// This is the rule-based stub. The next iteration swaps the body of
// `decideForCompany` for an llmChat call that takes the same inputs and
// returns the same shape.

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";
import { computeSegmentFunnels, type SegmentStats } from "@/lib/segment-funnels";
import { llmChat } from "@/lib/llm-proxy";
import type { BetAction } from "@/lib/investor-types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface CompanyRow {
  id: string;
  name: string;
  target_segment: string | null;
  thesis: string | null;
}

interface MetricSnapshot {
  segment: string;
  delivered: number;
  clicked: number;
  wechat: number;
  ctr: number;
  postClickConv: number;
  endToEnd: number;
}

interface Decision {
  conviction: number;
  action: BetAction;
  rationale: string;
}

// Map our internal customer-segment labels to the segment dimension key
// produced by computeSegmentFunnels. Only "geo_binary" is fully wired
// today; others fall through to overall totals.
function segmentForCompany(target: string | null): { dim: string; bucket: string } | null {
  if (!target) return null;
  if (target === "top_tier_academia") return { dim: "school_tier", bucket: "Tier 1" };
  if (target === "mid_tier_startup") return { dim: "school_tier", bucket: "Tier 2" };
  if (target === "gov_lab") return { dim: "geo_binary", bucket: "Domestic (.cn)" };
  if (target === "industry_research") return { dim: "geo_binary", bucket: "Overseas" };
  return null;
}

// Rule-based fallback used only when the LLM call fails. Anchors the
// system on real data so a network blip doesn't desync the bench.
function ruleBasedFallback(prev: { conviction: number } | null, snap: MetricSnapshot): Decision {
  const baseline = 0.012;
  const ratio = snap.delivered > 0 ? snap.endToEnd / baseline : 1;
  const prior = prev?.conviction ?? 0.5;
  let conviction = prior;
  let action: BetAction = "hold";
  if (snap.delivered < 30) conviction = prior * 0.95 + 0.5 * 0.05;
  else if (ratio >= 1.6) { conviction = Math.min(1, prior + 0.15); action = conviction > 0.85 ? "double_down" : "hold"; }
  else if (ratio >= 1.0) { conviction = Math.min(1, prior + 0.05); }
  else if (ratio >= 0.5) { conviction = Math.max(0, prior - 0.1); action = "trim"; }
  else { conviction = Math.max(0, prior - 0.2); action = conviction < 0.2 ? "cut" : "trim"; }
  return {
    conviction: Number(conviction.toFixed(3)),
    action,
    rationale: `(rule-based fallback) ${snap.delivered} delivered, endToEnd ${(snap.endToEnd * 100).toFixed(2)}%`,
  };
}

interface InvestorContext {
  id: string;
  name: string;
  style: string;
  system_prompt: string;
  memory: Array<{ at: string; note: string }>;
}

interface CompanyContext {
  id: string;
  name: string;
  thesis: string | null;
  target_segment: string | null;
  recent_episodic: Array<{ summary: string; details: Record<string, unknown>; occurred_at: string }>;
  prev_bets: Array<{ conviction: number; action: string; rationale: string; decided_at: string }>;
}

const INVESTOR_MODEL = "claude-sonnet-4.6";

async function decideViaLlm(
  investor: InvestorContext,
  company: CompanyContext,
  snap: MetricSnapshot,
): Promise<Decision & { memory_note?: string }> {
  const userPrompt = `## Portfolio review

You hold a position in **${company.name}**. Their thesis: "${company.thesis ?? "(no thesis recorded)"}". Target segment: ${company.target_segment ?? "(not set)"}.

## Latest metric snapshot (last 30 days, scoped to target segment)
- segment: ${snap.segment}
- delivered: ${snap.delivered}
- clicked: ${snap.clicked} (CTR ${(snap.ctr * 100).toFixed(2)}%)
- wechat: ${snap.wechat} (post-click conv ${(snap.postClickConv * 100).toFixed(2)}%)
- end-to-end: ${(snap.endToEnd * 100).toFixed(2)}% (org baseline ≈ 1.2%)

## Prior bets on this company (most recent first)
${company.prev_bets.length === 0
    ? "(none — first review)"
    : company.prev_bets.slice(0, 5).map((b) => `- ${new Date(b.decided_at).toLocaleDateString()}: conviction ${b.conviction.toFixed(2)}, action=${b.action}, "${b.rationale.slice(0, 140)}"`).join("\n")}

## Recent company history (episodic memory)
${company.recent_episodic.length === 0
    ? "(no contracts settled yet)"
    : company.recent_episodic.slice(0, 8).map((e) => `- ${new Date(e.occurred_at).toLocaleDateString()}: ${e.summary}`).join("\n")}

## Your accumulated memory across the portfolio
${investor.memory.length === 0
    ? "(no notes yet — this is your first quarter)"
    : investor.memory.slice(-8).map((m) => `- ${m.note}`).join("\n")}

## Task

Decide:
1. **conviction** (0.00 – 1.00): how much you believe this company will produce outsized returns relative to others.
2. **action** ∈ {"double_down" | "hold" | "trim" | "cut" | "fund"} — whether you'd allocate more, hold, reduce, fully exit, or initiate.
3. **rationale**: 1-2 sentences in your voice. Reference *specific* numbers above. Don't hedge.
4. **memory_note**: 1 sentence to remember about this company for future reviews. Pattern, watchout, or lesson.

Format strict JSON: { "conviction": 0.0-1.0, "action": "double_down"|"hold"|"trim"|"cut"|"fund", "rationale": string, "memory_note": string }`;

  const out = await llmChat({
    model: INVESTOR_MODEL,
    system: investor.system_prompt,
    user: userPrompt,
    json: true,
    max_tokens: 600,
    temperature: 0.4,
    timeoutMs: 60_000,
  });
  const stripped = (out.text ?? "").replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
  const parsed = JSON.parse(stripped) as { conviction: number; action: BetAction; rationale: string; memory_note?: string };
  const conviction = Math.max(0, Math.min(1, Number(parsed.conviction) || 0.5));
  const validActions: BetAction[] = ["double_down", "hold", "trim", "cut", "fund"];
  const action: BetAction = validActions.includes(parsed.action) ? parsed.action : "hold";
  return {
    conviction: Number(conviction.toFixed(3)),
    action,
    rationale: typeof parsed.rationale === "string" ? parsed.rationale : "(no rationale)",
    memory_note: typeof parsed.memory_note === "string" ? parsed.memory_note : undefined,
  };
}

export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const body = (await req.json().catch(() => ({}))) as { investor_id?: string };
  if (!body.investor_id) {
    return NextResponse.json({ error: "investor_id required" }, { status: 400 });
  }

  const { data: investor } = await supabase
    .from("investor_agents")
    .select("id, name, style, system_prompt, memory")
    .eq("id", body.investor_id)
    .maybeSingle();
  if (!investor) return NextResponse.json({ error: "investor not found" }, { status: 404 });

  const investorCtx: InvestorContext = {
    id: investor.id as string,
    name: investor.name as string,
    style: investor.style as string,
    system_prompt: investor.system_prompt as string,
    memory: ((investor.memory ?? []) as Array<{ at: string; note: string }>),
  };

  const { data: companies } = await supabase
    .from("bench_companies")
    .select("id, name, target_segment, thesis")
    .eq("funded_by", investor.id)
    .eq("active", true);

  if (!companies || companies.length === 0) {
    return NextResponse.json({ ok: true, decisions: [] });
  }

  // One pass over funnel data — apply to each company.
  const funnels = await computeSegmentFunnels({ lookbackDays: 30 });
  const decisions: Array<{ company_id: string; company_name: string; decision: Decision & { memory_note?: string }; snapshot: MetricSnapshot }> = [];
  const newMemoryNotes: Array<{ at: string; note: string }> = [];

  for (const c of companies as CompanyRow[]) {
    const segMap = segmentForCompany(c.target_segment);
    let segStats: SegmentStats | null = null;
    let segLabel = "all";
    if (segMap) {
      const dim = funnels.dimensions.find((d) => d.dimension === segMap.dim);
      segStats = dim?.segments.find((s) => s.segment === segMap.bucket) ?? null;
      if (segStats) segLabel = `${segMap.dim}:${segMap.bucket}`;
    }
    const snap: MetricSnapshot = {
      segment: segLabel,
      delivered: segStats?.delivered ?? funnels.totals.delivered,
      clicked: segStats?.clicked ?? funnels.totals.clicked,
      wechat: segStats?.wechat ?? funnels.totals.wechat,
      ctr: segStats?.ctr ?? funnels.totals.overallCtr,
      postClickConv: segStats?.postClickConv ?? funnels.totals.overallPostClick,
      endToEnd: segStats ? segStats.endToEnd : (funnels.totals.delivered > 0 ? funnels.totals.wechat / funnels.totals.delivered : 0),
    };

    const [{ data: prevBetsData }, { data: episodic }] = await Promise.all([
      supabase
        .from("investor_bets")
        .select("conviction, action, rationale, decided_at")
        .eq("investor_id", investor.id)
        .eq("company_id", c.id)
        .order("decided_at", { ascending: false })
        .limit(5),
      supabase
        .from("company_episodic_memory")
        .select("summary, details, occurred_at")
        .eq("company_id", c.id)
        .order("occurred_at", { ascending: false })
        .limit(8),
    ]);
    const prevBets = (prevBetsData ?? []) as Array<{ conviction: number; action: string; rationale: string; decided_at: string }>;
    const prev = prevBets.length > 0 ? { conviction: prevBets[0].conviction } : null;

    const companyCtx: CompanyContext = {
      id: c.id as string,
      name: c.name as string,
      thesis: c.thesis ?? null,
      target_segment: c.target_segment ?? null,
      recent_episodic: ((episodic ?? []) as Array<{ summary: string; details: Record<string, unknown>; occurred_at: string }>),
      prev_bets: prevBets,
    };

    let decision: Decision & { memory_note?: string };
    try {
      decision = await decideViaLlm(investorCtx, companyCtx, snap);
    } catch (err) {
      console.error("[investor/tick] LLM failed; using rule-based fallback", err);
      decision = ruleBasedFallback(prev, snap);
    }

    if (decision.memory_note) {
      newMemoryNotes.push({ at: new Date().toISOString(), note: `[${c.name}] ${decision.memory_note}` });
    }

    const now = new Date().toISOString();
    await supabase.from("investor_bets").insert({
      investor_id: investor.id,
      company_id: c.id,
      conviction: decision.conviction,
      action: decision.action,
      rationale: decision.rationale,
      metric_snapshot: snap,
      decided_at: now,
    });

    // Emit conviction-change event when meaningful (not on every tick).
    if (prev && Math.abs(decision.conviction - prev.conviction) >= 0.1) {
      await supabase.from("company_lifecycle").insert({
        company_id: c.id,
        event: "conviction_change",
        label: `Conviction ${prev.conviction.toFixed(2)} → ${decision.conviction.toFixed(2)} (${decision.action})`,
        meta: { investor_id: investor.id, prior: prev.conviction, next: decision.conviction, action: decision.action },
        occurred_at: now,
      });
    }
    if (decision.action === "cut") {
      await supabase.from("bench_companies").update({ active: false }).eq("id", c.id);
      await supabase.from("company_lifecycle").insert({
        company_id: c.id,
        event: "cut",
        label: `Cut by ${investor.name}`,
        meta: { investor_id: investor.id, rationale: decision.rationale },
        occurred_at: now,
      });
    }

    decisions.push({ company_id: c.id, company_name: c.name, decision, snapshot: snap });
  }

  // Append fresh memory notes back into the investor's persistent memory.
  // Cap at 60 entries (most recent kept) so the LLM context never balloons.
  if (newMemoryNotes.length > 0) {
    const updated = [...investorCtx.memory, ...newMemoryNotes].slice(-60);
    await supabase
      .from("investor_agents")
      .update({ memory: updated })
      .eq("id", investor.id);
  }

  return NextResponse.json({
    ok: true,
    investor: investor.name,
    decisions,
  });
}
