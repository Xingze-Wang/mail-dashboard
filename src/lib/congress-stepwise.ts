/**
 * Stepwise congress runner — alternative to the synchronous runner
 * in congress-runners.ts. Same persona rosters, same evidence pack,
 * same final artifacts. The difference: this runner persists state
 * after each persona so:
 *
 *   1. The /congress/[id]/live page can stream the deliberation as
 *      personas finish.
 *   2. Users can interject mid-run via POST /api/congress/runs/[id]/
 *      interject; the next persona's prompt picks them up before
 *      speaking.
 *   3. A long deliberation can survive a single Vercel function
 *      timeout (each step is one LLM call ~3-8s, well within the
 *      default 60s).
 *
 * Architecture:
 *   - startRun(kind) — builds evidence pack, picks roster, inserts
 *     a congress_runs row at status='running' current_idx=0.
 *   - stepRun(runId)  — runs ONE persona forward. Returns
 *     {status, current_idx, just_completed: persona_key}. Caller
 *     loops until status='completed'.
 *   - finalizeRun(runId) — auto-called by stepRun when synthesizer
 *     finishes. Parses synthesizer JSON, persists tactical_proposals
 *     row, runs template fan-out, notifies admin. Sets status='completed'
 *     and stamps tactical_proposal_id / template_proposal_id.
 *
 * Backward compat: the original synchronous functions in
 * congress-runners.ts stay as-is. Cron uses them. The stepwise path
 * is opt-in via the live UI / a wrapper that calls startRun + loops
 * stepRun until done.
 */

import { llmChat } from "@/lib/llm-proxy";
import { supabase } from "@/lib/db";
import { notifyAdminText } from "@/lib/congress";
import { WEEKLY_ROSTER, buildWeeklyEvidence } from "@/lib/congress-runners";

export interface CongressRunRow {
  id: string;
  kind: "weekly" | "monthly" | "postmortem";
  status: "running" | "completed" | "failed";
  evidence_pack: string;
  roster: Array<{ key: string; display: string; system: string; question: string }>;
  current_idx: number | null;
  personas_completed: Record<string, string>;
  synthesis: Record<string, unknown> | null;
  tactical_proposal_id: string | null;
  template_proposal_id: string | null;
  failure_reason: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface StepResult {
  status: CongressRunRow["status"];
  current_idx: number | null;
  just_completed_persona: string | null;
  text: string | null;
}

/**
 * Start a fresh weekly stepwise run. Builds evidence, snapshots the
 * roster, inserts a congress_runs row at status='running' current_idx=0.
 * Returns the run id so the caller can drive stepRun or hand the id
 * to the live UI.
 */
export async function startWeeklyRun(): Promise<string> {
  const evidence = await buildWeeklyEvidence();
  const { data, error } = await supabase
    .from("congress_runs")
    .insert({
      kind: "weekly",
      evidence_pack: evidence,
      // Strip system prompts down to the bare minimum we need to
      // reconstruct the persona at step time. We could store full
      // PersonaSpec but that's noise — the stepwise runner re-imports
      // WEEKLY_ROSTER from code and just keys by index.
      roster: WEEKLY_ROSTER,
      current_idx: 0,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`start run failed: ${error?.message ?? "unknown"}`);
  return data.id as string;
}

/**
 * Build the running-context block from completed personas. Called
 * before each step. Order matches the roster's order, not insertion
 * order — defensive against any future bug where personas land out
 * of sequence.
 */
function buildRunningContext(run: CongressRunRow): string {
  const parts: string[] = [];
  for (const p of run.roster) {
    const text = run.personas_completed[p.key];
    if (typeof text === "string" && text.length > 0) {
      parts.push(`### ${p.display}\n${text}`);
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : "";
}

/**
 * Drain pending interjections that should be visible to the persona
 * about to run (i.e. inject_after_idx <= current_idx). Marks them
 * consumed so they don't re-fire on the next step.
 *
 * Returns the formatted block to inject into the persona's prompt.
 */
async function drainInterjections(runId: string, currentIdx: number, currentPersonaKey: string): Promise<string> {
  const { data: pending } = await supabase
    .from("congress_interjections")
    .select("id, body, author_rep_id, inject_after_idx, created_at")
    .eq("run_id", runId)
    .is("consumed_at", null)
    .lte("inject_after_idx", currentIdx)
    .order("created_at", { ascending: true });

  if (!pending || pending.length === 0) return "";

  // Resolve author names for nicer display in the prompt.
  const repIds = [...new Set(pending.map((p) => p.author_rep_id as number))];
  const repName = new Map<number, string>();
  if (repIds.length > 0) {
    const { data: reps } = await supabase
      .from("sales_reps")
      .select("id, sender_name, name")
      .in("id", repIds);
    for (const r of reps ?? []) {
      repName.set(r.id as number, ((r.sender_name as string | null) ?? (r.name as string | null) ?? `rep#${r.id}`));
    }
  }

  // Mark consumed in one update — small batch, single round-trip.
  await supabase
    .from("congress_interjections")
    .update({
      consumed_at: new Date().toISOString(),
      consumed_by_persona: currentPersonaKey,
    })
    .in("id", pending.map((p) => p.id as string));

  const lines = pending.map((p) => {
    const name = repName.get(p.author_rep_id as number) ?? `rep#${p.author_rep_id}`;
    return `${name} 中途插话: ${(p.body as string).slice(0, 1500)}`;
  });
  return `\n## 中途插话 (人类参会者的评论 — 把它当成 panel 的一员; 把意见 take seriously, 但仍然要 evidence-bound)\n${lines.join("\n\n")}\n`;
}

/**
 * Run one persona forward. Atomic-ish: if anything fails after the
 * LLM call, the persona's text is lost (we don't write personas_completed
 * until the LLM call succeeds). Caller can retry by calling stepRun
 * again — current_idx didn't move, so we'll re-run the same persona.
 */
export async function stepRun(runId: string): Promise<StepResult> {
  const { data: run } = await supabase
    .from("congress_runs")
    .select("*")
    .eq("id", runId)
    .maybeSingle();
  if (!run) throw new Error(`Run ${runId} not found`);

  const r = run as unknown as CongressRunRow;
  if (r.status !== "running" || r.current_idx == null) {
    return { status: r.status, current_idx: r.current_idx, just_completed_persona: null, text: null };
  }
  if (r.current_idx >= r.roster.length) {
    // Should have been finalized; do it now defensively.
    await finalizeRun(runId);
    return { status: "completed", current_idx: null, just_completed_persona: null, text: null };
  }

  const persona = r.roster[r.current_idx];
  const runningContext = buildRunningContext(r);
  const interjections = await drainInterjections(runId, r.current_idx, persona.key);

  const userPrompt = `## ${r.kind} congress — your role: ${persona.display}
${persona.question}

## Shared evidence pack
${r.evidence_pack}
${runningContext ? "\n## What other panelists have said so far\n" + runningContext : ""}${interjections}

200 words max (synthesizer up to 1500). Cite specifics from the evidence pack. Don't repeat others.`;

  let text: string;
  try {
    const llmResp = await llmChat({
      model: "gemini-3-flash",
      system: persona.system,
      user: userPrompt,
      temperature: 0.5,
      max_tokens: persona.key === "synthesizer" ? 1500 : 800,
      timeoutMs: 30_000,
    });
    text = llmResp.text?.trim() || "(empty)";
  } catch (err) {
    text = `(persona errored: ${String(err).slice(0, 200)})`;
  }

  // Append to personas_completed and advance index. Single update.
  const newCompleted = { ...r.personas_completed, [persona.key]: text };
  const nextIdx = r.current_idx + 1;
  const isLast = nextIdx >= r.roster.length;
  await supabase
    .from("congress_runs")
    .update({
      personas_completed: newCompleted,
      current_idx: isLast ? null : nextIdx,
    })
    .eq("id", runId);

  if (isLast) {
    await finalizeRun(runId);
    return { status: "completed", current_idx: null, just_completed_persona: persona.key, text };
  }
  return { status: "running", current_idx: nextIdx, just_completed_persona: persona.key, text };
}

/**
 * Parse the synthesizer JSON, persist proposals, notify admin. Idempotent —
 * if synthesis is already set we just reaffirm and return.
 */
export async function finalizeRun(runId: string): Promise<void> {
  const { data: run } = await supabase
    .from("congress_runs")
    .select("*")
    .eq("id", runId)
    .maybeSingle();
  if (!run) return;
  const r = run as unknown as CongressRunRow;
  if (r.status === "completed" || r.status === "failed") return;

  const synthText = r.personas_completed["synthesizer"] ?? "";
  let synthJson: Record<string, unknown> | null = null;
  try {
    const cleaned = synthText.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
    synthJson = JSON.parse(cleaned);
  } catch (err) {
    await supabase
      .from("congress_runs")
      .update({
        status: "failed",
        failure_reason: `synthesizer JSON parse failed: ${(err as Error).message.slice(0, 200)}`,
        completed_at: new Date().toISOString(),
      })
      .eq("id", runId);
    return;
  }

  // For weekly: persist into tactical_proposals; run template fan-out
  // if the change_spec is template-shaped. (Re-implements the
  // post-synthesizer block from runWeeklyCongress, kept inline here
  // rather than imported because the synchronous and stepwise paths
  // diverge enough that sharing creates more hazard than savings.)
  let tacticalId: string | null = null;
  let templateId: string | null = null;
  let templateNote = "";
  if (r.kind === "weekly" && synthJson) {
    const skipReason = synthJson.skip_reason_if_no_proposal as string | null | undefined;
    if (skipReason) {
      await notifyAdminText(`📋 Weekly Congress (live, run=${runId.slice(0, 8)}): no proposal.\n${skipReason}`);
    } else {
      const { data: row } = await supabase
        .from("tactical_proposals")
        .insert({
          title: synthJson.title as string,
          deliberation: {
            personas: r.personas_completed,
            change_spec: synthJson.change_spec,
            evidence_pack_excerpt: r.evidence_pack.slice(0, 2000),
            congress_run_id: runId,
          },
          change_spec: synthJson.change_spec,
          expected_lift: synthJson.expected_lift,
          weeks_to_evaluate: (synthJson.weeks_to_evaluate as number | undefined) ?? 4,
        })
        .select()
        .single();
      tacticalId = row?.id as string | null;
      // Template fan-out — same path as the synchronous runner.
      const spec = synthJson.change_spec as { kind?: string; details?: Record<string, unknown> } | undefined;
      const isTemplateKind =
        spec?.kind === "template_phrase_swap" ||
        spec?.kind === "subject_line_test" ||
        spec?.kind === "subject_line" ||
        spec?.kind === "email_content" ||
        spec?.kind === "copy_edit";
      if (isTemplateKind && tacticalId) {
        try {
          const { craftAndGateProposal, inferSlotFromDescription } = await import("@/lib/template-prose-pipeline");
          const detailsStr = JSON.stringify(spec?.details ?? {});
          const segmentRaw = (spec?.details as { segment?: string } | undefined)?.segment;
          const segment = typeof segmentRaw === "string" ? segmentRaw : null;
          const slot = (spec?.kind === "subject_line" || spec?.kind === "subject_line_test")
            ? "subject_format" as const
            : inferSlotFromDescription(`${synthJson.title} ${detailsStr}`);
          const crafted = await craftAndGateProposal({
            hypothesis: synthJson.title as string,
            reasoning: detailsStr,
            proposed_test: detailsStr,
            segment,
            slot,
            proposedBy: "congress",
            evidence: {
              source: "weekly_congress_live",
              adversary_take: (r.personas_completed.adversary ?? "").slice(0, 400),
              psychologist_take: (r.personas_completed.psychologist ?? "").slice(0, 400),
            },
            tacticalProposalId: tacticalId,
          });
          if (crafted.ok) {
            templateId = crafted.templateId;
            templateNote = `\n📝 Template proposal drafted: ${crafted.name}`;
          } else {
            templateNote = `\n⚠️ Template prose draft blocked: ${crafted.error}`;
          }
        } catch (e) {
          templateNote = `\n⚠️ Template prose pipeline errored: ${(e as Error).message.slice(0, 200)}`;
        }
      }
      await notifyAdminText([
        `📋 Weekly Tactical Congress proposal (live deliberation, run=${runId.slice(0, 8)})`,
        ``,
        `Title: ${synthJson.title}`,
        `Expected lift: ${JSON.stringify(synthJson.expected_lift)}`,
        ``,
        `Adversary: "${(r.personas_completed.adversary || "").slice(0, 200)}"`,
        templateNote,
        ``,
        tacticalId ? `Approve: /api/tactical/${tacticalId}/decide?approved=1` : "",
        templateId ? `Preview prose: /templates/${templateId}/inspect` : "",
        `Live transcript: /congress/${runId}/live`,
      ].filter(Boolean).join("\n"));
    }
  }

  await supabase
    .from("congress_runs")
    .update({
      status: "completed",
      synthesis: synthJson,
      tactical_proposal_id: tacticalId,
      template_proposal_id: templateId,
      completed_at: new Date().toISOString(),
    })
    .eq("id", runId);
}

/**
 * Convenience: drive a run to completion in-process. Used by the
 * cron path (it has up to 5 minutes; 7 personas × ~5s each is well
 * within budget). Stops if a persona errors fatally.
 */
export async function driveToCompletion(runId: string, opts?: { maxSteps?: number }): Promise<void> {
  const max = opts?.maxSteps ?? 50;
  for (let i = 0; i < max; i++) {
    const r = await stepRun(runId);
    if (r.status !== "running") return;
  }
}
