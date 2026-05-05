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
import type { CompanyConfig, CompanyState, StepResult, MarketSignal } from "@/lib/bench-sim-types";
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
//   { action: "run_step", session_id }
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

    const { data: session } = await supabase.from("bench_sim_sessions").select("*").eq("id", session_id).single();
    if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });
    if (session.status === "complete") return NextResponse.json({ error: "session already complete" }, { status: 400 });

    const step = session.steps_completed as number;
    const loopsThisStep: Array<"weekly" | "monthly"> = ["weekly"];
    if ((step + 1) % 4 === 0) loopsThisStep.push("monthly");

    const { data: companyRows } = await supabase.from("bench_companies").select("*").in("id", session.company_ids as string[]);
    const companies = (companyRows ?? []) as CompanyConfig[];

    const stateMap = new Map<string, CompanyState>();
    for (const company of companies) {
      const { data: stateRow } = await supabase
        .from("bench_company_states")
        .select("state")
        .eq("session_id", session_id)
        .eq("company_id", company.id)
        .eq("step", step - 1)
        .single();

      const state: CompanyState = (stateRow?.state as CompanyState) ?? {
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

    const sampleIdx = step % CONGRESS_SAMPLES.length;
    const sample = CONGRESS_SAMPLES[sampleIdx];

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
          company_id: pr.company_id as string,
          session_id,
          step: pr.step as number,
          loop: pr.loop as StepResult["loop"],
          personas: (pr.personas as Record<string, string>) ?? {},
          recommendation: pr.recommendation as StepResult["recommendation"],
          confidence: pr.confidence as number | null,
          change: pr.change_spec as StepResult["change"],
          rationale: pr.rationale as string | null,
          extra_fields: (pr.extra_fields as Record<string, string>) ?? {},
          latency_s: (pr.latency_s as number) ?? 0,
          error: pr.error as string | null,
        };
        const sig = extractMarketSignal(partialResult, co.name);
        if (sig) priorSignals.push(sig);
      }
    }

    await supabase.from("bench_sim_sessions").update({ status: "running" }).eq("id", session_id);

    const allResults: StepResult[] = [];

    for (const loop of loopsThisStep) {
      const loopResults = await Promise.allSettled(
        companies.map(async (company) => {
          const state = stateMap.get(company.id)!;
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

    const { data: insertedSteps } = await supabase.from("bench_step_results").insert(
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
    ).select("id, company_id, loop");

    // ── Materialize approved synthesizer outputs as company_proposals so
    //    the editor populates with real LLM thoughts. We submit only the
    //    weekly results that produced an actionable change_spec; reject /
    //    defer recommendations are read-only on the timeline.
    try {
      const { submitProposal } = await import("@/lib/proposals");
      for (const r of allResults) {
        if (r.loop !== "weekly") continue;
        if (!r.change || !r.change.kind) continue;
        if (r.recommendation !== "approve") continue;

        // Map the synthesizer's change kind to our proposal kind taxonomy.
        const kindMap: Record<string, "subject_test" | "draft_revise" | "routing_rule" | "pacing_change"> = {
          subject_line_test: "subject_test",
          template_phrase_swap: "draft_revise",
          copy_edit: "draft_revise",
          routing_tweak: "routing_rule",
          scope_expansion: "pacing_change",
        };
        const proposalKind = kindMap[r.change.kind] ?? "draft_revise";

        // Find the bench_step_results row id so we can link back.
        const matchedStep = (insertedSteps ?? []).find(
          (s) => s.company_id === r.company_id && s.loop === "weekly",
        );

        await submitProposal({
          company_id: r.company_id,
          contract_id: null,
          investor_id: null,
          kind: proposalKind,
          payload: {
            change: r.change,
            step_id: matchedStep?.id ?? null,
            step: r.step,
            confidence: r.confidence,
            session_id,
          },
          prediction: r.rationale ?? r.change.details ?? "",
        }).catch((err) => console.error("[bench-sim] submitProposal failed", err));
      }
    } catch (err) {
      console.error("[bench-sim] proposal materialization failed", err);
    }

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

    const nextStepCount = step + 1;
    const isDone = nextStepCount >= (session.steps_planned as number);
    await supabase.from("bench_sim_sessions").update({
      steps_completed: nextStepCount,
      status: isDone ? "complete" : "paused",
    }).eq("id", session_id);

    return NextResponse.json({ step, results: allResults, done: isDone });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
