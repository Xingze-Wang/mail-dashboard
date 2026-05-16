// guided_tasks — OpenClaw-style multi-step task execution with
// admin checkpoints between every step.
//
// Lifecycle:
//   planned → (admin Yes) → running → [step 0 done → admin ack] →
//   running → [step 1 done → ack] → ... → completed
//
// Or any time mid-flight: admin says "abort" → aborted.
// Or a step fails fatally → failed.

import { supabase } from "@/lib/db";

export interface GuidedStep {
  intent: string;       // "I will do X"
  verification?: string; // "expect to see Y"
  risk_level?: "auto" | "review";  // auto = lookup-only, no admin click needed
}

export interface GuidedStepResult {
  ok: boolean;
  summary: string;
  evidence?: unknown;
  ran_at: string;
  ack?: "continue" | "modified" | "aborted";
}

export interface AdminNote {
  step_index: number;
  text: string;
  at: string;
}

export interface GuidedTaskRow {
  id: string;
  goal: string;
  constraints: string | null;
  steps: GuidedStep[];
  step_results: GuidedStepResult[];
  current_step: number;
  status: "planned" | "running" | "paused" | "completed" | "aborted" | "failed";
  awaiting_step_ack: number | null;  // null = no pause; N = paused at step N
  admin_notes: AdminNote[];
  proposed_by_rep_id: number | null;
  approved_by_rep_id: number | null;
  created_at: string;
  approved_at: string | null;
  completed_at: string | null;
  aborted_at: string | null;
  abort_reason: string | null;
  inbox_id: string | null;
}

export async function proposeGuidedTask(args: {
  goal: string;
  constraints?: string;
  steps: GuidedStep[];
  proposed_by_rep_id: number | null;
}): Promise<{ ok: true; id: string; inbox_id: string | null } | { ok: false; error: string }> {
  if (!args.goal || args.goal.trim().length < 5) {
    return { ok: false, error: "goal too short (≥5 chars)" };
  }
  if (!Array.isArray(args.steps) || args.steps.length === 0) {
    return { ok: false, error: "steps required (≥1)" };
  }
  if (args.steps.length > 20) {
    return { ok: false, error: "too many steps (max 20 — break into smaller tasks)" };
  }
  for (const [i, s] of args.steps.entries()) {
    if (!s.intent || s.intent.trim().length < 5) {
      return { ok: false, error: `step ${i}: intent too short` };
    }
  }

  const { data: row, error } = await supabase
    .from("guided_tasks")
    .insert({
      goal: args.goal.trim().slice(0, 1000),
      constraints: args.constraints?.trim().slice(0, 1000) ?? null,
      steps: args.steps,
      proposed_by_rep_id: args.proposed_by_rep_id,
    })
    .select("id")
    .single();
  if (error || !row) return { ok: false, error: error?.message ?? "insert failed" };

  // Push admin Lark Yes/No card for plan approval
  let inboxId: string | null = null;
  try {
    const stepPreview = args.steps
      .map((s, i) => `  ${i + 1}. ${s.intent}${s.verification ? ` — expect: ${s.verification}` : ""}`)
      .join("\n");
    const headline = `🗺 多步任务计划: ${args.goal.slice(0, 100)}`.slice(0, 200);
    const body = [
      `**Goal:** ${args.goal}`,
      args.constraints ? `**Constraints:** ${args.constraints}` : null,
      `**Plan (${args.steps.length} 步):**\n${stepPreview}`,
      "_Yes 开始执行 — 每步完成后我会暂停, 等你 ack 才继续. No 取消计划._",
    ].filter(Boolean).join("\n\n");

    const enc = new TextEncoder();
    const key = `guided_task|${row.id}`;
    const buf = await crypto.subtle.digest("SHA-256", enc.encode(key));
    const dedupHash = Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const { data: inbox } = await supabase
      .from("admin_inbox")
      .insert({
        kind: "request",
        headline,
        body,
        source_rep_id: args.proposed_by_rep_id,
        evidence: {
          source: "guided_task_plan",
          guided_task_id: row.id,
          step_count: args.steps.length,
        },
        dedup_hash: dedupHash,
      })
      .select("id")
      .single();
    inboxId = inbox?.id ?? null;
    if (inboxId) {
      await supabase.from("guided_tasks").update({ inbox_id: inboxId }).eq("id", row.id);
      const { sendAdminInboxCard } = await import("@/lib/admin-inbox-card");
      await sendAdminInboxCard({
        inbox_id: inboxId,
        kind: "request",
        headline,
        body,
        source_rep_id: args.proposed_by_rep_id,
        evidence: { source: "guided_task_plan", guided_task_id: row.id },
      });
    }
  } catch (err) {
    console.warn("[guided-tasks] card push failed (non-blocking):", err);
  }
  return { ok: true, id: row.id, inbox_id: inboxId };
}

/** Admin approved the plan → flip to running, allow first step to execute. */
export async function approveGuidedTaskPlan(args: {
  task_id: string;
  approved_by_rep_id: number;
}): Promise<{ ok: boolean; error?: string; task?: GuidedTaskRow }> {
  const { data: row, error } = await supabase
    .from("guided_tasks")
    .select("*")
    .eq("id", args.task_id)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!row) return { ok: false, error: "task not found" };
  if (row.status === "running" || row.status === "paused") return { ok: true, task: row as GuidedTaskRow };
  if (row.status !== "planned") return { ok: false, error: `cannot approve from status=${row.status}` };

  const { data: updated, error: updErr } = await supabase
    .from("guided_tasks")
    .update({
      status: "running",
      approved_by_rep_id: args.approved_by_rep_id,
      approved_at: new Date().toISOString(),
    })
    .eq("id", args.task_id)
    .select("*")
    .single();
  if (updErr) return { ok: false, error: updErr.message };
  return { ok: true, task: updated as GuidedTaskRow };
}

/** Record a step's outcome and pause for admin ack. */
export async function recordStepResult(args: {
  task_id: string;
  step_index: number;
  result: Omit<GuidedStepResult, "ran_at" | "ack">;
}): Promise<{ ok: boolean; error?: string; done?: boolean; needs_ack?: boolean }> {
  const { data: row } = await supabase
    .from("guided_tasks")
    .select("*")
    .eq("id", args.task_id)
    .maybeSingle();
  if (!row) return { ok: false, error: "task not found" };
  const t = row as GuidedTaskRow;
  if (t.status !== "running") return { ok: false, error: `task not running (status=${t.status})` };
  if (args.step_index !== t.current_step) {
    return { ok: false, error: `expected step ${t.current_step}, got ${args.step_index}` };
  }

  const newResults = [...t.step_results, { ...args.result, ran_at: new Date().toISOString() }];
  const isLastStep = args.step_index >= t.steps.length - 1;

  // Decide: pause for admin ack, or auto-continue?
  // Rule: pause iff the NEXT step is risk_level=review. If next is
  // 'auto' (lookup-only), continue straight through. Last step always
  // terminates as 'completed' regardless.
  const nextStep = !isLastStep ? t.steps[t.current_step + 1] : null;
  const nextNeedsAck = nextStep?.risk_level === "review";
  const newStatus = isLastStep ? "completed" : (nextNeedsAck ? "paused" : "running");

  await supabase
    .from("guided_tasks")
    .update({
      step_results: newResults,
      current_step: isLastStep ? t.current_step : t.current_step + 1,
      status: newStatus,
      awaiting_step_ack: nextNeedsAck ? t.current_step + 1 : null,
      completed_at: isLastStep ? new Date().toISOString() : null,
    })
    .eq("id", t.id);

  return { ok: true, done: isLastStep, needs_ack: nextNeedsAck };
}

/**
 * Admin ack of a paused step. 'continue' resumes → next step can run.
 * 'modified' means admin gave a course correction (in DM) → re-flag step
 * for re-run (we keep status=paused and let Leon re-do step based on
 * the conversation context). 'aborted' → terminal.
 */
export async function ackGuidedStep(args: {
  task_id: string;
  ack: "continue" | "modified" | "aborted";
  abort_reason?: string;
}): Promise<{ ok: boolean; error?: string; new_status?: string }> {
  const { data: row } = await supabase
    .from("guided_tasks")
    .select("*")
    .eq("id", args.task_id)
    .maybeSingle();
  if (!row) return { ok: false, error: "task not found" };
  const t = row as GuidedTaskRow;
  if (t.status !== "paused" && t.status !== "running") {
    return { ok: false, error: `task not paused (status=${t.status})` };
  }

  // Tag the last step result with the ack
  const results = [...t.step_results];
  if (results.length > 0) results[results.length - 1] = { ...results[results.length - 1], ack: args.ack };

  if (args.ack === "aborted") {
    await supabase
      .from("guided_tasks")
      .update({
        status: "aborted",
        aborted_at: new Date().toISOString(),
        abort_reason: args.abort_reason?.slice(0, 500) ?? null,
        step_results: results,
      })
      .eq("id", t.id);
    return { ok: true, new_status: "aborted" };
  }

  // continue or modified → status back to running so next step can fire,
  // and clear the awaiting-ack pointer
  await supabase
    .from("guided_tasks")
    .update({
      status: "running",
      step_results: results,
      awaiting_step_ack: null,
    })
    .eq("id", t.id);

  // Kick the executor so the next step actually runs. ack must return
  // fast to the caller (web button click or Lark tool-result handler).
  //
  // Wrap in next/server `after()` so on Vercel serverless the platform
  // keeps the function alive until the executor finishes — without this
  // wrap, `void ...` lets the serverless function terminate as soon as
  // ack returns and the agent loop is killed mid-step (we saw status
  // stuck at 'running' for 60s+ in prod, step_results empty). The
  // worker / smoke path falls back to plain fire-and-forget since
  // those hosts are long-lived.
  const taskId = t.id;
  const kick = () =>
    executeNextGuidedStep({ task_id: taskId }).catch((err) => {
      console.error("[guided-tasks] post-ack kick failed:", err);
    });
  try {
    const { after } = await import("next/server");
    after(kick);
  } catch {
    void kick();
  }

  return { ok: true, new_status: "running" };
}

/** Admin attaches a free-text note to a step before approving it. */
export async function addAdminNote(args: {
  task_id: string;
  step_index: number;
  text: string;
}): Promise<{ ok: boolean; error?: string }> {
  if (!args.text || args.text.trim().length < 2) {
    return { ok: false, error: "note text required" };
  }
  const { data: row } = await supabase
    .from("guided_tasks")
    .select("admin_notes")
    .eq("id", args.task_id)
    .maybeSingle();
  if (!row) return { ok: false, error: "task not found" };
  const notes = (row.admin_notes ?? []) as AdminNote[];
  const next = [...notes, { step_index: args.step_index, text: args.text.slice(0, 500), at: new Date().toISOString() }];
  const { error } = await supabase
    .from("guided_tasks")
    .update({ admin_notes: next })
    .eq("id", args.task_id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function listGuidedTasks(args: {
  status?: "planned" | "running" | "paused" | "completed" | "aborted" | "failed" | "all";
  limit?: number;
}): Promise<GuidedTaskRow[]> {
  const limit = Math.max(1, Math.min(50, args.limit ?? 20));
  let q = supabase
    .from("guided_tasks")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (args.status && args.status !== "all") q = q.eq("status", args.status);
  const { data } = await q;
  return (data ?? []) as GuidedTaskRow[];
}

export async function getGuidedTask(taskId: string): Promise<GuidedTaskRow | null> {
  const { data } = await supabase
    .from("guided_tasks")
    .select("*")
    .eq("id", taskId)
    .maybeSingle();
  return (data ?? null) as GuidedTaskRow | null;
}

/**
 * Drive execution of the current step by invoking the Lark agent with a
 * synthetic "run step N of task T" prompt. The agent decides which tools
 * to call (lookup / write / dm / etc.) and is instructed to finish by
 * calling record_step_result, which advances the FSM.
 *
 * Mirrors commit 08ee324: instead of inventing new infrastructure, route
 * planned work through the existing tool dispatcher (runAgent →
 * runReadTool). This is the missing executor — without it,
 * approveGuidedTaskPlan flips status to "running" but nothing ever
 * actually runs the steps.
 *
 * Recursion: handled by the auto-continue rule inside recordStepResult.
 * If next step is risk_level=auto, status stays "running" and we kick
 * ourselves again (bounded by step count and a hard cap to prevent runaway).
 */
export async function executeNextGuidedStep(args: {
  task_id: string;
  max_chain?: number;  // how many auto-continue steps to run in one kick (default 6)
}): Promise<{ ok: boolean; error?: string; ran_steps?: number; final_status?: string }> {
  const maxChain = Math.max(1, Math.min(20, args.max_chain ?? 6));
  let ranSteps = 0;
  let lastStatus: string | undefined;

  for (let chain = 0; chain < maxChain; chain++) {
    const { data: row, error } = await supabase
      .from("guided_tasks")
      .select("*")
      .eq("id", args.task_id)
      .maybeSingle();
    if (error) return { ok: false, error: error.message, ran_steps: ranSteps };
    if (!row) return { ok: false, error: "task not found", ran_steps: ranSteps };
    const task = row as GuidedTaskRow;
    lastStatus = task.status;

    // Only execute when status=running AND we're not paused on a review step.
    if (task.status !== "running") break;
    if (task.awaiting_step_ack !== null) break;
    if (task.current_step >= task.steps.length) break;

    const step = task.steps[task.current_step];
    if (!step) break;

    // Pull the proposer to act as the agent's "session". Falls back to
    // admin (rep_id=5) so the agent has admin-grade tool access — multi-step
    // tasks come from /admin/intent or Leon's start_guided_task, both
    // admin-gated paths.
    const repId = task.proposed_by_rep_id ?? 5;
    const { data: rep, error: repErr } = await supabase
      .from("sales_reps")
      .select("id, name, sender_email, role")
      .eq("id", repId)
      .maybeSingle();
    if (repErr || !rep) {
      return {
        ok: false,
        error: `proposer rep ${repId} not found${repErr ? `: ${repErr.message}` : ""}`,
        ran_steps: ranSteps,
      };
    }

    // Build a synthetic agent prompt that frames the current step as a
    // direct instruction from admin. The agent's existing system prompt
    // already covers record_step_result usage — we just hand it the
    // step and remind it to close the loop.
    const stepPrompt = [
      `你正在执行 guided_task ${task.id.slice(0, 8)}, 这是第 ${task.current_step + 1}/${task.steps.length} 步.`,
      `**整体目标**: ${task.goal}`,
      task.constraints ? `**约束**: ${task.constraints}` : null,
      "",
      `**当前 step**: ${step.intent}`,
      step.verification ? `**预期看到**: ${step.verification}` : null,
      "",
      task.step_results.length > 0
        ? "**前面已完成的 step 结果**:\n" + task.step_results
            .map((r, i) => `  ${i + 1}. ${r.ok ? "✅" : "⚠️"} ${r.summary.slice(0, 200)}`)
            .join("\n")
        : null,
      "",
      "现在: (1) 用 ```lookup``` 调对应工具完成这一步, (2) 拿到结果后**必须**再用一个 ```lookup``` 调 record_step_result " +
        `({task_id: "${task.id}", step_index: ${task.current_step}, summary: "<这步做了啥+看到啥>", ok: true|false, evidence?: ...}). ` +
        "summary 要具体 (写出关键数字 / id / 名字), 别写 '完成了'. 不调 record_step_result 这步就不算完, 后面卡死.",
    ].filter(Boolean).join("\n");

    try {
      // Dynamic import to break circular dependency (lark-agent imports
      // helper-read-tools which imports guided-tasks indirectly via the
      // record_step_result branch).
      const { runAgent } = await import("@/lib/lark-agent");
      await runAgent(
        {
          repId: rep.id,
          role: (rep.role ?? "admin") as "admin" | "senior" | "sales",
          repName: rep.name ?? undefined,
          email: (rep as { sender_email?: string }).sender_email ?? undefined,
          messageId: null,
        },
        stepPrompt,
        [],
      );
      ranSteps += 1;
    } catch (err) {
      console.error("[guided-tasks] executeNextGuidedStep agent failure:", err);
      // Mark the task as failed so the UI surfaces the breakage.
      await supabase
        .from("guided_tasks")
        .update({
          status: "failed",
          abort_reason: `executor failure: ${String(err).slice(0, 200)}`,
        })
        .eq("id", args.task_id);
      return { ok: false, error: String(err).slice(0, 200), ran_steps: ranSteps };
    }

    // After runAgent returns, recordStepResult (called by the agent)
    // should have advanced current_step. Loop and check the new state.
    // If the agent didn't call record_step_result, the next iteration
    // sees the same current_step and the same status — we break to
    // avoid an infinite loop.
    const { data: after } = await supabase
      .from("guided_tasks")
      .select("current_step, status, awaiting_step_ack")
      .eq("id", args.task_id)
      .maybeSingle();
    if (!after) break;
    if (
      (after.current_step as number) === task.current_step &&
      after.status === "running" &&
      after.awaiting_step_ack === null
    ) {
      // Agent finished without advancing the step — treat as a soft fail
      // and stop. Don't mark the whole task failed; admin can inspect
      // and resume or abort.
      console.warn(
        `[guided-tasks] step ${task.current_step} of task ${task.id} did not advance — agent likely skipped record_step_result`,
      );
      break;
    }
  }

  return { ok: true, ran_steps: ranSteps, final_status: lastStatus };
}

/** Send admin a DM after a step completes, asking for ack. */
export async function notifyAdminStepDone(args: {
  task: GuidedTaskRow;
  step_index: number;
  result_summary: string;
  is_last: boolean;
}): Promise<void> {
  const adminId = 5;
  const { data: admin } = await supabase
    .from("sales_reps")
    .select("lark_open_id")
    .eq("id", adminId)
    .maybeSingle();
  const openId = admin?.lark_open_id;
  if (!openId) return;

  const stepIntent = args.task.steps[args.step_index]?.intent ?? "(?)";
  const nextIntent = args.is_last ? null : args.task.steps[args.step_index + 1]?.intent;
  const lines = [
    args.is_last ? "🏁 **任务完成**" : `✅ **Step ${args.step_index + 1}/${args.task.steps.length} 完成**`,
    `_Task: ${args.task.goal.slice(0, 100)}_`,
    "",
    `**做了:** ${stepIntent}`,
    `**结果:** ${args.result_summary.slice(0, 400)}`,
  ];
  if (!args.is_last && nextIntent) {
    lines.push("", `**下一步:** ${nextIntent}`);
    lines.push(`回 "继续 ${args.task.id.slice(0, 8)}" 继续, "改 ... " 给指引, "停 ${args.task.id.slice(0, 8)}" abort.`);
  }
  try {
    const { getTenantAccessToken, pickBase } = await import("@/lib/lark");
    const token = await getTenantAccessToken();
    if (!token) return;
    if (process.env.SMOKE_NO_CARDS === "1") return;
    await fetch(`${pickBase()}/im/v1/messages?receive_id_type=open_id`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        receive_id: openId,
        msg_type: "text",
        content: JSON.stringify({ text: lines.join("\n") }),
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.warn("[guided-tasks] notify DM failed:", err);
  }
}
