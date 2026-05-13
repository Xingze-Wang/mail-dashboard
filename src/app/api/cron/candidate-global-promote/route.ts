import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { evaluateCandidate } from "@/lib/template-candidate-gate";
import { requireSession } from "@/lib/auth-helpers";

export const preferredRegion = ["hkg1"];
export const maxDuration = 300;

const MIN_SAMPLE = 30;
const MIN_PREDICTIONS = 20;
const LOOKBACK_DAYS = 30;
const PREDICTED_LIFT_REQUIRED = 1.1;

interface PerTemplateResult {
  template_id: string;
  rep_id: number;
  template_name: string;
  sample_size: number;
  predictions_count: number;
  passes?: boolean;
  reason?: string;
  skipped_reason?: string;
  inbox_action?: "created" | "updated" | "no_change" | "dismissed_by_system";
}

interface RunResult {
  ran_at: string;
  dry: boolean;
  per_template: PerTemplateResult[];
}

async function run(dry: boolean): Promise<RunResult> {
  const result: RunResult = { ran_at: new Date().toISOString(), dry, per_template: [] };
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();

  const perRepTemplates = await supabase
    .from("email_templates")
    .select("id, rep_id, name, proposed_by")
    .eq("active", true)
    .not("rep_id", "is", null);
  if (perRepTemplates.error) {
    throw new Error(`per-rep templates query failed: ${perRepTemplates.error.message}`);
  }

  const globalT = await supabase
    .from("email_templates")
    .select("id, name")
    .is("rep_id", null)
    .eq("active", true)
    .maybeSingle();
  if (!globalT.data) {
    return result;
  }

  const ctrPrompt = await supabase
    .from("model_prompts")
    .select("id")
    .eq("kind", "ctr_regressor")
    .eq("active", true)
    .maybeSingle();
  const ctrPromptId = ctrPrompt.data?.id ?? null;

  const globalEmails = await supabase
    .from("emails")
    .select("id, status, created_at")
    .eq("template_id", globalT.data.id)
    .gte("created_at", since)
    .limit(2000);
  if (globalEmails.error) {
    throw new Error(`global emails query failed: ${globalEmails.error.message}`);
  }
  const globalSent = globalEmails.data?.length ?? 0;
  const globalEmailIds = (globalEmails.data ?? []).map((e) => e.id as string);
  const globalClicked = await countClicks(globalEmailIds);
  const globalPredicted = ctrPromptId
    ? await avgPredictedPClick(globalEmailIds, ctrPromptId)
    : 0;

  for (const tpl of perRepTemplates.data ?? []) {
    const entry: PerTemplateResult = {
      template_id: tpl.id as string,
      rep_id: tpl.rep_id as number,
      template_name: tpl.name as string,
      sample_size: 0,
      predictions_count: 0,
    };

    const perRepEmails = await supabase
      .from("emails")
      .select("id, created_at")
      .eq("template_id", tpl.id)
      .gte("created_at", since)
      .limit(2000);
    if (perRepEmails.error) {
      entry.skipped_reason = `query failed: ${perRepEmails.error.message}`;
      result.per_template.push(entry);
      continue;
    }
    const perRepSent = perRepEmails.data?.length ?? 0;
    entry.sample_size = perRepSent;
    if (perRepSent < MIN_SAMPLE) {
      entry.skipped_reason = `sample size ${perRepSent} < ${MIN_SAMPLE}`;
      result.per_template.push(entry);
      continue;
    }

    const perRepEmailIds = perRepEmails.data!.map((e) => e.id as string);
    const perRepClicked = await countClicks(perRepEmailIds);
    let perRepPredicted = 0;
    let perRepPredictionCount = 0;
    if (ctrPromptId) {
      const r = await predictionStats(perRepEmailIds, ctrPromptId);
      perRepPredicted = r.avg;
      perRepPredictionCount = r.count;
    }
    entry.predictions_count = perRepPredictionCount;
    if (perRepPredictionCount < MIN_PREDICTIONS) {
      entry.skipped_reason = `predictions ${perRepPredictionCount} < ${MIN_PREDICTIONS}`;
      result.per_template.push(entry);
      continue;
    }

    const gate = evaluateCandidate({
      perRep: { clicked: perRepClicked, sent: perRepSent },
      global: { clicked: globalClicked, sent: globalSent },
      perRepPredicted,
      globalPredicted,
      predictedLiftRequired: PREDICTED_LIFT_REQUIRED,
    });
    entry.passes = gate.passes;
    entry.reason = gate.reason;

    const dedupHash = `candidate-global-${tpl.id}`;
    const evidence = {
      rep_id: tpl.rep_id,
      per_rep_template_id: tpl.id,
      global_template_id: globalT.data.id,
      sample_size: perRepSent,
      actual_per_rep: {
        clicked: perRepClicked,
        sent: perRepSent,
        rate: perRepClicked / perRepSent,
        wilson_lower: gate.perRepCI.lower,
        wilson_upper: gate.perRepCI.upper,
      },
      actual_global: {
        clicked: globalClicked,
        sent: globalSent,
        rate: globalSent > 0 ? globalClicked / globalSent : 0,
        wilson_lower: gate.globalCI.lower,
        wilson_upper: gate.globalCI.upper,
      },
      predicted_per_rep: perRepPredicted,
      predicted_global: globalPredicted,
      predicted_lift: gate.predictedLift,
      decision_run_at: result.ran_at,
      proposed_by_source: tpl.proposed_by,
    };

    if (gate.passes) {
      if (dry) {
        entry.inbox_action = "created";
      } else {
        const upsert = await supabase
          .from("admin_inbox")
          .upsert(
            {
              kind: "candidate_global_template",
              headline: `Per-rep template "${tpl.name}" beats global on both signals`,
              body:
                `Sample: ${perRepSent} sends from rep #${tpl.rep_id} vs ${globalSent} on global.\n\n` +
                `${gate.reason}\n\n` +
                `Review at /admin/templates/candidates`,
              evidence,
              status: "pending",
              dedup_hash: dedupHash,
            },
            { onConflict: "dedup_hash" },
          );
        entry.inbox_action = upsert.error ? "no_change" : "updated";
      }
    } else {
      const prior = await supabase
        .from("admin_inbox")
        .select("id, status")
        .eq("dedup_hash", dedupHash)
        .maybeSingle();
      if (prior.data && prior.data.status === "pending") {
        if (!dry) {
          await supabase
            .from("admin_inbox")
            .update({ status: "dismissed_by_system", body: `Evidence changed: ${gate.reason}` })
            .eq("id", prior.data.id);
        }
        entry.inbox_action = "dismissed_by_system";
      } else {
        entry.inbox_action = "no_change";
      }
    }

    result.per_template.push(entry);
  }

  return result;
}

async function countClicks(emailIds: string[]): Promise<number> {
  if (emailIds.length === 0) return 0;
  const r = await supabase
    .from("webhook_events")
    .select("email_id", { count: "exact", head: true })
    .eq("type", "email.clicked")
    .in("email_id", emailIds);
  if (r.error) {
    console.error(`[candidate-global-promote] countClicks failed: ${r.error.message}`);
    return 0;
  }
  return r.count ?? 0;
}

async function avgPredictedPClick(emailIds: string[], promptId: string): Promise<number> {
  const r = await predictionStats(emailIds, promptId);
  return r.avg;
}

async function predictionStats(emailIds: string[], promptId: string): Promise<{ avg: number; count: number }> {
  if (emailIds.length === 0) return { avg: 0, count: 0 };
  const r = await supabase
    .from("model_predictions")
    .select("headline")
    .eq("prompt_id", promptId)
    .in("target_id", emailIds);
  if (r.error || !r.data || r.data.length === 0) return { avg: 0, count: 0 };
  let sum = 0;
  let n = 0;
  for (const row of r.data) {
    const v = Number(row.headline);
    if (Number.isFinite(v)) {
      sum += v;
      n++;
    }
  }
  return { avg: n > 0 ? sum / n : 0, count: n };
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") || "";
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const result = await run(dry);
  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  const session = await requireSession(req);
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "admin only" }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  const dry = body.dry === true;
  const result = await run(dry);
  return NextResponse.json(result);
}
